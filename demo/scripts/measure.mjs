// Gas and storage measurements for docs/THREAT_MODEL.md (security review).
//   cd demo && node scripts/measure.mjs
import { setupVault, requestPayment, N, U } from '../src/vault.js';

const env = await setupVault({ vaultNear: 40, sharedCap: 30 });
const { root, owner, vault, vendor, agents, usdc } = env;
const T = (g) => (g / 1e12).toFixed(1);
const receipts = (raw) => raw.result.receipts_outcome.map((o) => ({ id: o.id, gas: o.outcome.gas_burnt, exec: o.outcome.executor_id, logs: o.outcome.logs }));
const total = (raw) => raw.result.transaction_outcome.outcome.gas_burnt + raw.result.receipts_outcome.reduce((n, o) => n + o.outcome.gas_burnt, 0);
const storage = async () => (await vault.accountView()).storage_usage;
const out = {};
try {
  await owner.call(vault, 'set_shared_cap', { shared_cap: N(30) });
  const big = await root.createSubAccount('big-agent', { initialBalance: N(10) });
  await owner.call(vault, 'add_agent', { agent: big.accountId, per_tx_max: N(1), period_limit: N(30), approval_threshold: N(1) });

  // 1. Native payment, empty memo: first receipt = request_payment, then transfer, then on_payout.
  const s0 = await storage();
  const r1 = await requestPayment(big, vault, { requestId: 'm1', recipient: vendor.accountId, amountNear: 0.001, memo: '' });
  const rc = receipts(r1.raw).filter((x) => x.exec === vault.accountId);
  out.request_payment_native = T(rc[0].gas);
  out.on_payout_native = T(rc[rc.length - 1].gas);
  out.total_native = T(total(r1.raw));
  out.storage_bytes_per_request_empty_memo = (await storage()) - s0;

  // 2. Max-size encrypted memo (512 chars) to measure worst-case record size.
  const memo = 'enc1:' + 'A'.repeat(507);
  const s1 = await storage();
  await requestPayment(big, vault, { requestId: 'm2-' + 'x'.repeat(60), recipient: vendor.accountId, amountNear: 0.001, memo });
  out.storage_bytes_per_request_max_memo = (await storage()) - s1;

  // 3. Token payment: request_payment, storage_balance_of, on_recipient_checked, ft_transfer, on_payout.
  if (usdc) {
    const r3 = await requestPayment(agents[0], vault, { requestId: 'm3', recipient: vendor.accountId, amountUsdc: 0.5, token: usdc.accountId, memo: '' });
    const own = receipts(r3.raw).filter((x) => x.exec === vault.accountId);
    out.request_payment_token = T(own[0].gas);
    out.on_recipient_checked = T(own[1]?.gas ?? 0);
    out.on_payout_token = T(own[own.length - 1].gas);
    out.total_token = T(total(r3.raw));
  }

  // 3b. Origin-checked payment, worst case: a task with 10 payees and 10
  //     trusted sources, amount labelled from the last trusted source.
  {
    await owner.call(vault, 'set_label_vouch', { agent: big.accountId, vouched: true });
    const payees = [vendor.accountId];
    for (let i = 1; i < 10; i++) payees.unshift(`payee-${i}.test.near`);
    const sources = Array.from({ length: 10 }, (_, i) => `email:vendor-${i}.example`);
    const st = await storage();
    const ct = await owner.callRaw(vault, 'create_task', {
      id: 'measure-task-' + 'x'.repeat(51), agent: big.accountId, description: 'd'.repeat(256), payees, token: null,
      budget: N(5), max_per_payment: N(1), trusted_sources: sources, expires_at_ms: Date.now() + 86_400_000,
    }, { gas: '300000000000000' });
    out.create_task_max = T(total(ct.raw ?? ct));
    out.storage_bytes_per_task_max = (await storage()) - st;
    const origin = {
      task_id: 'measure-task-' + 'x'.repeat(51),
      recipient: { kind: 'owner' },
      amount: { kind: 'source', source: sources[9], digest: 'ab'.repeat(32) },
    };
    const so = await storage();
    const ro = await requestPayment(big, vault, { requestId: 'mo', recipient: vendor.accountId, amountNear: 0.001, memo: '', origin });
    if (ro.outcome.outcome !== 'dispatched') throw new Error(JSON.stringify(ro.outcome));
    out.request_payment_with_origin = T(receipts(ro.raw).filter((x) => x.exec === vault.accountId)[0].gas);
    out.storage_bytes_per_request_with_origin = (await storage()) - so;
    await owner.call(vault, 'close_task', { id: origin.task_id });
  }

  // 4. Worst-case sweep: 99 open approvals that all expire, then one request
  //    releases SWEEP_LIMIT (10) of them while scanning the whole open set.
  await owner.call(vault, 'add_agent', { agent: big.accountId, per_tx_max: N(1), period_limit: N(30), approval_threshold: '0' });
  await owner.call(vault, 'set_approval_ttl', { approval_ttl_ms: 1_800_000 });
  for (let i = 0; i < 99; i++) {
    const r = await requestPayment(big, vault, { requestId: `p${i}`, recipient: vendor.accountId, amountNear: 0.001, memo: '' });
    if (r.outcome.outcome !== 'pending_approval') throw new Error(JSON.stringify(r.outcome));
  }
  const open = (await vault.view('get_config', {})).open_payments;
  out.open_payments_before_sweep = open;
  const plain = await requestPayment(big, vault, { requestId: 'nosweep', recipient: vendor.accountId, amountNear: 0.001, memo: '' });
  out.request_payment_open_set_full_nothing_due = T(receipts(plain.raw)[0].gas);
  const block = async () => (await env.worker.provider.block({ finality: 'final' })).header.timestamp / 1e6;
  const req = await vault.view('get_request', { key: `${big.accountId}:p98` });
  while ((await block()) < req.expires_at_ms) await env.worker.provider.fastForward(60);
  const sweep = await requestPayment(agents[0], vault, { requestId: 'sweeper', recipient: vendor.accountId, amountNear: 0.001, memo: '' });
  out.request_payment_with_full_sweep = T(receipts(sweep.raw)[0].gas);
  out.expired_in_that_call = sweep.logs.filter((l) => l.includes('payment_expired')).length;
  const exp = await vendor.callRaw(vault, 'expire_pending', { limit: 100 }, { gas: '300000000000000' });
  out.expire_pending_100 = T(total(exp.raw ?? exp));
  out.expired_by_expire_pending = exp.parseResult();
} finally {
  await env.api?.close(); await env.worker.tearDown();
}
console.log(JSON.stringify(out, null, 2));
