// Integration tests against a real local NEAR node (near-workspaces sandbox).
// These exercise what unit tests can't: real async transfers, real failures,
// #[private] enforcement and function-call access keys.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pkg from 'near-workspaces';
import { transactions } from 'near-api-js';
import { setupVault, requestPayment, events, N, U, fmt } from '../src/vault.js';
import { startPaidApi, paidFetch } from '../src/paid-api.js';
import { keyPairFromPassphrase, hiddenEntry, open as openSealed } from '../src/privacy.js';

const { createKeyPair } = pkg;
let env;

before(async () => { env = await setupVault(); });
after(async () => { await env?.api?.close(); await env?.worker.tearDown(); });

const balance = async (acc) => BigInt((await acc.balance()).total.toString());

test('prompt-injected drain to attacker is rejected and nothing moves', async () => {
  const { vault, attacker, agents } = env;
  const [research] = agents;
  const vaultBefore = await balance(vault);
  const attackerBefore = await balance(attacker);

  const r = await requestPayment(research, vault, {
    requestId: 'inj-1', recipient: attacker.accountId, amountNear: 9, memo: 'URGENT vendor wallet migration',
  });
  assert.deepEqual(r.outcome, { outcome: 'rejected', reason: 'recipient_not_allowlisted' });
  assert.ok(events(r.logs).some((e) => e.event === 'payment_rejected'));
  assert.equal(await balance(attacker), attackerBefore);
  // Vault only loses nothing (agent paid the gas, not the vault).
  assert.ok(await balance(vault) >= vaultBefore);
  assert.deepEqual(await vault.view('list_requests', {}), []);
  const blocked = await vault.view('list_blocked', {});
  assert.equal(blocked[0].recipient, attacker.accountId);
  assert.equal(blocked[0].reason, 'recipient_not_allowlisted');
});

test('drain to an allowlisted vendor is capped per request', async () => {
  const { vault, vendor, agents } = env;
  const r = await requestPayment(agents[0], vault, {
    requestId: 'inj-2', recipient: vendor.accountId, amountNear: 9, memo: 'prepay a year',
  });
  assert.deepEqual(r.outcome, { outcome: 'rejected', reason: 'exceeds_per_request_max' });
});

test('function-call key: agent can only call request_payment', async () => {
  const { vault, attacker, agents, root } = env;
  const ops = agents[1];
  const kp = createKeyPair();
  // Owner of the agent account installs a restricted key: vault + request_payment only.
  await ops.batch(ops).addKey(
    kp.getPublicKey().toString(),
    transactions.functionCallAccessKey(vault.accountId, ['request_payment'], BigInt(N(0.25))),
  ).transact();
  // From now on, the agent process only holds the restricted key.
  const fullKey = await ops.getKey();
  await ops.setKey(kp);

  // A direct NEAR transfer is impossible with this key.
  await assert.rejects(ops.transfer(attacker, N(1)));
  // So is calling any other vault method, or any other contract.
  await assert.rejects(ops.call(vault, 'allow_recipient', { recipient: attacker.accountId }));
  await assert.rejects(ops.call(root, 'anything', {}));
  // The one allowed path still works and is policy-checked.
  const r = await requestPayment(ops, vault, {
    requestId: 'fck-1', recipient: attacker.accountId, amountNear: 1, memo: '',
  });
  assert.equal(r.outcome.outcome, 'rejected');
  await ops.setKey(fullKey);
});

test('successful payout settles and pays the vendor', async () => {
  const { vault, vendor, agents } = env;
  const before = await balance(vendor);
  const r = await requestPayment(agents[0], vault, {
    requestId: 'ok-1', recipient: vendor.accountId, amountNear: 0.2, memo: 'weather API invoice #881',
  });
  assert.equal(r.outcome.outcome, 'dispatched');
  const req = await vault.view('get_request', { key: r.outcome.key });
  assert.equal(req.status, 'Settled');
  assert.equal(await balance(vendor) - before, BigInt(N(0.2)));
  const a = await vault.view('get_agent', { agent: agents[0].accountId });
  assert.equal(a.spent, N(0.2));
  assert.equal(a.reserved, '0');
});

test('real failed transfer releases the budget exactly once and refunds the vault', async () => {
  const { vault, owner, agents } = env;
  const ghost = 'ghost.test.near'; // never created, so the transfer fails
  await owner.call(vault, 'allow_recipient', { recipient: ghost });
  const vaultBefore = await balance(vault);
  const agentBefore = await vault.view('get_agent', { agent: agents[0].accountId });

  const r = await requestPayment(agents[0], vault, {
    requestId: 'fail-1', recipient: ghost, amountNear: 0.5, memo: 'vendor account was deleted',
  });
  assert.equal(r.outcome.outcome, 'dispatched');
  const evs = events(r.logs).map((e) => e.event);
  assert.ok(evs.includes('payment_failed'), `events: ${evs}`);

  const req = await vault.view('get_request', { key: r.outcome.key });
  assert.equal(req.status, 'Failed');
  const a = await vault.view('get_agent', { agent: agents[0].accountId });
  assert.equal(a.reserved, '0');
  assert.equal(a.spent, agentBefore.spent);
  const b = await vault.view('get_balances', {});
  assert.equal(b.in_flight, '0');
  // Refund came back: vault is down by storage for the record only (< 0.01 NEAR).
  const diff = vaultBefore - (await balance(vault));
  assert.ok(diff < BigInt(N(0.01)), `vault lost ${fmt(diff.toString())} NEAR`);

  // Retrying the same id does not re-send.
  const again = await requestPayment(agents[0], vault, {
    requestId: 'fail-1', recipient: ghost, amountNear: 0.5, memo: 'retry',
  });
  assert.deepEqual(again.outcome, { outcome: 'duplicate', key: r.outcome.key, status: 'Failed' });
});

test('only the vault can call its own payout callback', async () => {
  const { vault, vendor, agents } = env;
  const r = await requestPayment(agents[0], vault, {
    requestId: 'cb-1', recipient: vendor.accountId, amountNear: 0.1, memo: '',
  });
  await assert.rejects(agents[0].call(vault, 'on_payout', { key: r.outcome.key }), /private/i);
});

test('over-threshold payment waits for the owner, then pays', async () => {
  const { vault, owner, vendor, agents } = env;
  const buyer = agents[2];
  const r = await requestPayment(buyer, vault, {
    requestId: 'big-1', recipient: vendor.accountId, amountNear: 0.5, memo: 'GPU hours',
  });
  assert.equal(r.outcome.outcome, 'pending_approval');
  await assert.rejects(buyer.call(vault, 'approve', { key: r.outcome.key }), /owner only/);
  const before = await balance(vendor);
  await owner.call(vault, 'approve', { key: r.outcome.key }, { gas: '100000000000000' });
  assert.equal((await vault.view('get_request', { key: r.outcome.key })).status, 'Settled');
  assert.equal(await balance(vendor) - before, BigInt(N(0.5)));
});

test('shared cap holds across all agents', async () => {
  const { vault, vendor, agents } = env;
  let accepted = 0;
  for (let i = 0; i < 12; i++) {
    const r = await requestPayment(agents[i % 2], vault, {
      requestId: `cap-${i}`, recipient: vendor.accountId, amountNear: 0.5, memo: '',
    });
    if (r.outcome.outcome === 'dispatched') accepted++;
  }
  const b = await vault.view('get_balances', {});
  assert.ok(BigInt(b.shared_spent) + BigInt(b.shared_reserved) <= BigInt(b.shared_cap));
  assert.ok(accepted < 12);
});

test('pause stops everything', async () => {
  const { vault, owner, vendor, agents } = env;
  await owner.call(vault, 'pause', {});
  const r = await requestPayment(agents[1], vault, {
    requestId: 'p-1', recipient: vendor.accountId, amountNear: 0.1, memo: '',
  });
  assert.deepEqual(r.outcome, { outcome: 'rejected', reason: 'vault_paused' });
  await owner.call(vault, 'unpause', {});
});

// ----------------------------------------------------------------- USDC (NEP-141)

const ftBalance = async (token, acc) => BigInt(await token.view('ft_balance_of', { account_id: acc.accountId }));
const usdcView = async (vault, token) => (await vault.view('list_tokens', {})).find((t) => t.token === token.accountId);

test('USDC: an allowed payment settles through ft_transfer', async () => {
  const { vault, vendor, agents, usdc } = env;
  const vendorBefore = await ftBalance(usdc, vendor);
  const r = await requestPayment(agents[0], vault, {
    requestId: 'usdc-1', recipient: vendor.accountId, amountUsdc: 7.5, token: usdc.accountId, memo: 'Inference credits',
  });
  assert.equal(r.outcome.outcome, 'dispatched');
  assert.equal(await ftBalance(usdc, vendor) - vendorBefore, BigInt(U(7.5)));
  const req = await vault.view('get_request', { key: r.outcome.key });
  assert.equal(req.status, 'Settled');
  assert.equal(req.token, usdc.accountId);
  const t = await usdcView(vault, usdc);
  assert.equal(t.balance, U(492.5));
  assert.equal(t.shared_spent, U(7.5));
  // The vault's own record matches the token contract.
  assert.equal(BigInt(t.balance), await ftBalance(usdc, vault));
  // NEAR budgets are separate.
  const limits = await vault.view('get_agent_token_limits', { agent: agents[0].accountId });
  assert.equal(limits[0][1].spent, U(7.5));
});

test('USDC: injected drain to the attacker is rejected, no tokens move', async () => {
  const { vault, attacker, agents, usdc } = env;
  const before = await ftBalance(usdc, vault);
  const r = await requestPayment(agents[0], vault, {
    requestId: 'usdc-inj', recipient: attacker.accountId, amountUsdc: 400, token: usdc.accountId,
  });
  assert.deepEqual(r.outcome, { outcome: 'rejected', reason: 'recipient_not_allowlisted' });
  assert.equal(await ftBalance(usdc, vault), before);
  const blocked = await vault.view('list_blocked', {});
  assert.equal(blocked[0].token, usdc.accountId);
});

test('USDC: unregistered recipient fails cleanly and the budget comes back', async () => {
  const { root, owner, vault, agents, usdc } = env;
  const fresh = await root.createSubAccount('fresh-vendor', { initialBalance: N(2) });
  await owner.call(vault, 'allow_recipient', { recipient: fresh.accountId });
  const before = await usdcView(vault, usdc);
  const r = await requestPayment(agents[1], vault, {
    requestId: 'usdc-unreg', recipient: fresh.accountId, amountUsdc: 3, token: usdc.accountId,
  });
  assert.equal(r.outcome.outcome, 'dispatched');
  const req = await vault.view('get_request', { key: r.outcome.key });
  assert.equal(req.status, 'Failed');
  assert.equal(req.failure_reason, 'recipient_not_registered');
  const after = await usdcView(vault, usdc);
  assert.equal(after.balance, before.balance);
  assert.equal(after.shared_reserved, '0');
  assert.equal(after.in_flight, '0');
  assert.equal(BigInt(after.balance), await ftBalance(usdc, vault));
  const limits = await vault.view('get_agent_token_limits', { agent: agents[1].accountId });
  assert.equal(limits[0][1].reserved, '0');
});

test('USDC: big payment waits for the owner, then settles', async () => {
  const { owner, vault, vendor, agents, usdc } = env;
  const r = await requestPayment(agents[2], vault, {
    requestId: 'usdc-big', recipient: vendor.accountId, amountUsdc: 20, token: usdc.accountId,
  });
  assert.equal(r.outcome.outcome, 'pending_approval');
  assert.equal((await usdcView(vault, usdc)).pending_approval, U(20));
  await owner.call(vault, 'approve', { key: r.outcome.key }, { gas: (150n * 10n ** 12n).toString() });
  const req = await vault.view('get_request', { key: r.outcome.key });
  assert.equal(req.status, 'Settled');
  const t = await usdcView(vault, usdc);
  assert.equal(t.pending_approval, '0');
  assert.equal(BigInt(t.balance), await ftBalance(usdc, vault));
});

test('USDC: tokens from a contract the owner never added are refunded', async () => {
  const { root, owner, vault } = env;
  const fake = await root.createSubAccount('fake-usd', { initialBalance: N(10) });
  await fake.deploy((await import('../src/vault.js')).FT_WASM);
  await fake.call(fake, 'new', { symbol: 'FAKE', decimals: 6 });
  await owner.call(fake, 'storage_deposit', { account_id: vault.accountId }, { attachedDeposit: N(0.01) });
  await fake.call(fake, 'mint', { account_id: owner.accountId, amount: U(10) });
  await owner.call(fake, 'ft_transfer_call', { receiver_id: vault.accountId, amount: U(10), msg: '' },
    { attachedDeposit: '1', gas: (100n * 10n ** 12n).toString() });
  assert.equal(await fake.view('ft_balance_of', { account_id: owner.accountId }), U(10));
  assert.equal((await vault.view('list_tokens', {})).length, 1);
});

// ------------------------------------------------------------ pay-per-call API

async function api() {
  if (!env.api) {
    env.api = await startPaidApi({
      vendorId: env.vendor.accountId, vaultId: env.vault.accountId, tokenId: env.usdc.accountId,
      nodeUrl: env.worker.provider.connection.url, finality: 'optimistic',
    });
  }
  return env.api;
}
const payAs = (agent) => ({ requestId, recipient, amountUnits, token, memo }) =>
  requestPayment(agent, env.vault, { requestId, recipient, amountUnits, token, memo }).then((r) => r.outcome);

test('paid API: no payment, no data; the quote names the vault, vendor and price', async () => {
  const a = await api();
  const r = await fetch(`${a.url}/v1/forecast?city=Lisbon`);
  assert.equal(r.status, 402);
  const { quote } = await r.json();
  assert.equal(quote.vault, env.vault.accountId);
  assert.equal(quote.recipient, env.vendor.accountId);
  assert.equal(quote.token, env.usdc.accountId);
  assert.equal(quote.price, U(0.25));
});

test('paid API: agent pays through the vault, vendor verifies on-chain and serves once', async () => {
  const a = await api();
  const [research] = env.agents;
  const before = await ftBalance(env.usdc, env.vendor);
  const url = `${a.url}/v1/forecast?city=Porto`;
  const r = await paidFetch(url, { agentId: research.accountId, vaultId: env.vault.accountId, pay: payAs(research) });
  assert.equal(r.status, 'ok');
  assert.equal(r.data.city, 'Porto');
  assert.equal(await ftBalance(env.usdc, env.vendor) - before, BigInt(U(0.25)));
  // The same proof can't be used twice, or for another endpoint.
  const proof = { headers: { 'x-banbo-payment': `${research.accountId}:${r.quote.id}` } };
  assert.equal((await fetch(url, proof)).status, 409);
  const other = await fetch(`${a.url}/v1/history?city=Porto`, proof);
  assert.equal((await other.json()).error, 'quote_is_for_another_endpoint');
});

test('paid API: claiming an unpaid or underpaid quote gets nothing', async () => {
  const a = await api();
  const [research] = env.agents;
  const url = `${a.url}/v1/history?city=Faro`;
  const { quote } = await (await fetch(url)).json();
  const proof = { headers: { 'x-banbo-payment': `${research.accountId}:${quote.id}` } };
  assert.equal((await (await fetch(url, proof)).json()).error, 'payment_not_found');
  // Pay less than the quote under the quote's id.
  const o = await payAs(research)({ requestId: quote.id, recipient: quote.recipient, amountUnits: U(0.1), token: quote.token, memo: 'cheap' });
  assert.equal(o.outcome, 'dispatched');
  assert.equal((await (await fetch(url, proof)).json()).error, 'payment_does_not_match_quote');
});

test('paid API: a purchase over the agent limit is blocked and nothing is served', async () => {
  const a = await api();
  const [research] = env.agents;
  const before = await ftBalance(env.usdc, env.vault);
  const r = await paidFetch(`${a.url}/v1/bulk-export`, { agentId: research.accountId, vaultId: env.vault.accountId, pay: payAs(research) });
  assert.equal(r.status, 'blocked');
  assert.equal(r.reason, 'exceeds_per_request_max');
  assert.equal(await ftBalance(env.usdc, env.vault), before);
});

test('paid API: the agent refuses a quote that asks it to pay through another vault', async () => {
  const [research] = env.agents;
  let paid = false;
  const fakeFetch = async () => ({ status: 402, json: async () => ({ quote: { id: 'q-x', vault: 'evil-vault.test.near', recipient: env.attacker.accountId, price: U(1) } }) });
  const r = await paidFetch('http://x/v1/forecast', { agentId: research.accountId, vaultId: env.vault.accountId, pay: async () => { paid = true; }, fetchImpl: fakeFetch });
  assert.equal(r.status, 'refused');
  assert.equal(paid, false);
});

// ------------------------------------------------------------ risk rules

test('risk rules: a newly allowed recipient waits out the cooldown', async () => {
  const { root, owner, vault, agents } = env;
  const fresh = await root.createSubAccount('late-vendor', { initialBalance: N(2) });
  await owner.call(vault, 'set_risk_rules', { recipient_cooldown_ms: 4000, max_payments_per_hour: 0 });
  try {
    // The long-standing vendor is unaffected; the new one is not payable yet.
    await owner.call(vault, 'allow_recipient', { recipient: fresh.accountId });
    const r1 = await requestPayment(agents[2], vault, { requestId: 'cool-1', recipient: fresh.accountId, amountNear: 0.01, memo: '' });
    assert.deepEqual(r1.outcome, { outcome: 'rejected', reason: 'recipient_in_cooldown' });
    const rec = (await vault.view('list_recipients', {})).find((r) => r.account === fresh.accountId);
    assert.equal(rec.payable_from_ms - rec.added_at_ms, 4000);
    await new Promise((ok) => setTimeout(ok, 5000));
    const r2 = await requestPayment(agents[2], vault, { requestId: 'cool-2', recipient: fresh.accountId, amountNear: 0.01, memo: '' });
    assert.equal(r2.outcome.outcome, 'dispatched');
  } finally {
    await owner.call(vault, 'set_risk_rules', { recipient_cooldown_ms: 0, max_payments_per_hour: 0 });
  }
});

test('risk rules: per-hour payment limit stops a slow drip', async () => {
  const { owner, vault, vendor, agents } = env;
  const buyer = agents[2];
  const used = (await vault.view('get_agent_rate', { agent: buyer.accountId })).count;
  await owner.call(vault, 'set_risk_rules', { recipient_cooldown_ms: 0, max_payments_per_hour: used + 2 });
  try {
    for (const id of ['drip-1', 'drip-2']) {
      const r = await requestPayment(buyer, vault, { requestId: id, recipient: vendor.accountId, amountNear: 0.01, memo: 'tiny' });
      assert.equal(r.outcome.outcome, 'dispatched');
    }
    const r = await requestPayment(buyer, vault, { requestId: 'drip-3', recipient: vendor.accountId, amountNear: 0.01, memo: 'tiny' });
    assert.deepEqual(r.outcome, { outcome: 'rejected', reason: 'exceeds_payment_rate' });
  } finally {
    await owner.call(vault, 'set_risk_rules', { recipient_cooldown_ms: 0, max_payments_per_hour: 0 });
  }
});

// ------------------------------------------------------------ private mode

test('private mode: hidden vendor is paid with its salt, a reused salt pays nobody else', async () => {
  const { root, owner, vault, attacker, agents } = env;
  const keys = keyPairFromPassphrase('test passphrase', vault.accountId);
  const quiet = await root.createSubAccount('quiet-vendor', { initialBalance: N(1) });
  const entry = hiddenEntry(quiet.accountId, keys.publicKey, 'test');
  await owner.call(vault, 'allow_hidden_recipient', { fingerprint: entry.fingerprint, label: entry.label });
  const listed = await vault.view('list_hidden_recipients', {});
  assert.ok(listed.some((h) => h.fingerprint === entry.fingerprint));
  assert.ok(!JSON.stringify(listed).includes('quiet-vendor'), 'account name is not in state');
  assert.ok(!(await vault.view('list_allowlist', {})).includes(quiet.accountId));
  // The owner can read their own label back.
  assert.deepEqual(JSON.parse(openSealed(listed.find((h) => h.fingerprint === entry.fingerprint).label, keys.secretKey)),
    { account: quiet.accountId, salt: entry.salt, note: 'test' });

  const before = await balance(quiet);
  const r = await requestPayment(agents[0], vault, { requestId: 'hid-1', recipient: quiet.accountId, amountNear: 0.1, memo: '', recipientSalt: entry.salt });
  assert.equal(r.outcome.outcome, 'dispatched');
  assert.equal(await balance(quiet) - before, BigInt(N(0.1)));
  assert.equal((await vault.view('get_request', { key: r.outcome.key })).recipient_fingerprint, entry.fingerprint);

  const none = await requestPayment(agents[0], vault, { requestId: 'hid-2', recipient: quiet.accountId, amountNear: 0.1, memo: '' });
  assert.deepEqual(none.outcome, { outcome: 'rejected', reason: 'recipient_not_allowlisted' });
  const reuse = await requestPayment(agents[0], vault, { requestId: 'hid-3', recipient: attacker.accountId, amountNear: 0.1, memo: '', recipientSalt: entry.salt });
  assert.deepEqual(reuse.outcome, { outcome: 'rejected', reason: 'recipient_not_allowlisted' });
});

test('private mode: memos are sealed to the owner and plaintext is refused', async () => {
  const { owner, vault, vendor, agents } = env;
  const keys = keyPairFromPassphrase('test passphrase', vault.accountId);
  await owner.call(vault, 'set_privacy', { owner_encryption_key: keys.publicKey, encrypted_memos_only: true });
  try {
    const memo = 'Q4 data license, contract #8812';
    const r = await requestPayment(agents[0], vault, { requestId: 'enc-1', recipient: vendor.accountId, amountNear: 0.05, memo, sealTo: keys.publicKey });
    assert.equal(r.outcome.outcome, 'dispatched');
    const stored = (await vault.view('get_request', { key: r.outcome.key })).memo;
    assert.ok(stored.startsWith('enc1:') && !stored.includes('8812'));
    assert.equal(openSealed(stored, keys.secretKey), memo);
    assert.ok(!r.logs.join('\n').includes('8812'), 'event logs carry ciphertext only');
    const wrong = keyPairFromPassphrase('someone else', vault.accountId);
    assert.equal(openSealed(stored, wrong.secretKey), null);

    const p = await requestPayment(agents[0], vault, { requestId: 'enc-2', recipient: vendor.accountId, amountNear: 0.05, memo: 'Invoice 2291 for Acme' });
    assert.deepEqual(p.outcome, { outcome: 'rejected', reason: 'memo_not_encrypted' });
    assert.ok(!p.logs.join('\n').includes('Acme'));
    assert.equal((await vault.view('list_blocked', {}))[0].memo, '');
  } finally {
    await owner.call(vault, 'set_privacy', { owner_encryption_key: keys.publicKey, encrypted_memos_only: false });
  }
});

test('private mode: with TEE required, an agent without an attestation cannot spend', async () => {
  const { root, owner, vault, vendor, agents } = env;
  await owner.call(vault, 'set_tee_policy', { require_tee: true, attestation_ttl_ms: 86_400_000, allow_sw_hardening_needed: false });
  try {
    const r = await requestPayment(agents[0], vault, { requestId: 'tee-1', recipient: vendor.accountId, amountNear: 0.05, memo: '' });
    assert.deepEqual(r.outcome, { outcome: 'rejected', reason: 'agent_not_attested' });

    // A TEE-style agent: an implicit account, added by the owner, submits a
    // forged quote. The contract runs Intel DCAP verification and refuses it.
    const kp = createKeyPair('ed25519');
    const implicit = Buffer.from(kp.getPublicKey().data).toString('hex');
    await root.transfer(implicit, N(2));
    const teeAgent = root.getAccount(implicit);
    await teeAgent.setKey(kp);
    await owner.call(vault, 'add_agent', { agent: implicit, per_tx_max: N(0.1), period_limit: N(1), approval_threshold: N(0.1) });
    const m = { mrtd: '11'.repeat(48), rtmr0: '22'.repeat(48), rtmr1: '33'.repeat(48), rtmr2: '44'.repeat(48), compose_hash: '55'.repeat(32), key_provider_digest: null };
    const id = await owner.call(vault, 'approve_tee_measurement', { measurement: m });
    assert.equal((await vault.view('get_tee_policy', {})).measurements[0][0], id);
    const forged = {
      quote: '04000200'.repeat(160),
      collateral: { pck_crl_issuer_chain: '', root_ca_crl: '', pck_crl: '', tcb_info_issuer_chain: '', tcb_info: '{}', tcb_info_signature: '', qe_identity_issuer_chain: '', qe_identity: '{}', qe_identity_signature: '' },
      tcb_info: { compose_hash: '55'.repeat(32), app_compose: '{}', event_log: [] },
    };
    const res = await teeAgent.callRaw(vault, 'attest_agent', { attestation: forged }, { gas: '300000000000000' });
    assert.match(JSON.stringify(res.failures), /attestation rejected: quote rejected/);
    assert.equal(await vault.view('get_agent_tee', { agent: implicit }), null);
    const r2 = await requestPayment(teeAgent, vault, { requestId: 'tee-2', recipient: vendor.accountId, amountNear: 0.05, memo: '' });
    assert.deepEqual(r2.outcome, { outcome: 'rejected', reason: 'agent_not_attested' });
  } finally {
    await owner.call(vault, 'set_tee_policy', { require_tee: false, attestation_ttl_ms: 86_400_000, allow_sw_hardening_needed: false });
  }
});
