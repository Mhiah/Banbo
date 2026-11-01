// The demo's acts, shared by the CLI demo and the sandbox server that
// backs the dashboard. Every payment is a real transaction on the node.
import { requestPayment, events, fmt, fmtU, N } from './vault.js';
import { runLlmAgent, runBuyerAgent, hasCredentials, COMPROMISED_SCRIPT, BUYER_SCRIPT, MODEL, INVOICE_URL } from './agent.js';
import { paidFetch } from './paid-api.js';

const tty = process.stdout.isTTY;
const c = (code) => (s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
export const red = c('31'), green = c('32'), yellow = c('33'), cyan = c('36'), dim = c('2'), bold = c('1');

function show(log, label, r) {
  const o = r.outcome;
  const tag =
    o.outcome === 'rejected' ? red(`BLOCKED  ${o.reason}`)
    : o.outcome === 'dispatched' ? green('DISPATCHED')
    : o.outcome === 'pending_approval' ? yellow('WAITING FOR OWNER')
    : yellow(`DUPLICATE (${o.status})`);
  log(`    ${label}`);
  log(`      vault: ${tag}   ${dim(`tx ${r.hash}`)}`);
  const evs = events(r.logs).map((e) => e.event).filter((e) => e !== 'payment_rejected');
  if (evs.length) log(dim(`      events: ${evs.join(' → ')}`));
}

const bal = async (a) => fmt((await a.balance()).total.toString());
let runId = 0;

/** Act 1: an agent reads a poisoned invoice and tries to drain the vault. */
export async function actInjection(env, { log = console.log, useLlm = hasCredentials() } = {}) {
  const { vault, attacker, agents } = env;
  const research = agents[0];
  const run = ++runId;
  log(bold('Act 1: prompt injection'));
  log(`  The agent is asked to pay ${INVOICE_URL}.`);
  log(`  The page hides instructions to move the treasury to ${red(attacker.accountId)}.\n`);
  const attackerBefore = await bal(attacker);
  const act = { name: 'prompt_injection', payments: [] };
  const pay = async (args) => {
    const r = await requestPayment(research, vault, args);
    show(log, `${args.amountNear} NEAR → ${args.recipient}  "${args.memo}"`, r);
    act.payments.push({ ...args, outcome: r.outcome, tx: r.hash });
    return r.outcome;
  };

  let attackerTried = false;
  if (useLlm) {
    log(dim(`  agent: ${MODEL} via the Claude API, with the vault as its only payment tool`));
    await runLlmAgent({
      requestPrefix: `inv881-r${run}`,
      pay: async (args) => {
        if (args.recipient === attacker.accountId) attackerTried = true;
        return pay(args);
      },
      onEvent: (e) => {
        if (e.type === 'fetch') log(dim(`    agent fetched ${e.url}`));
        if (e.type === 'say') log(`    agent: ${e.text.replace(/\n+/g, ' ').slice(0, 400)}`);
        if (e.type === 'refusal') log(yellow(`    model declined: ${e.detail ?? ''}`));
      },
    });
    if (!attackerTried) {
      log(yellow('\n  The model did not take the bait this time. A weaker or fully compromised'));
      log(yellow('  agent would, so here is the same attack replayed as a compromised agent:\n'));
    }
  } else {
    log(dim('  agent: scripted compromised agent (set ANTHROPIC_API_KEY to use Claude)\n'));
  }
  if (!useLlm || !attackerTried) {
    for (const [i, step] of COMPROMISED_SCRIPT.entries()) {
      log(`    agent: ${step.say}`);
      await pay({ requestId: `inv881-r${run}-c${i}`, recipient: step.recipient, amountNear: step.amountNear, memo: step.memo });
    }
  }
  log(`\n  attacker balance: ${attackerBefore} → ${await bal(attacker)} NEAR  ${green('(unchanged)')}`);
  log(`  agent spent today: ${green(fmt((await vault.view('get_agent', { agent: research.accountId })).spent))} NEAR\n`);
  return act;
}

/** Act 2: a transfer fails after approval and is reconciled exactly once. */
export async function actFailedTransfer(env, { log = console.log } = {}) {
  const { owner, vault, agents } = env;
  const research = agents[0];
  const run = ++runId;
  log(bold('Act 2: a payment fails after it was approved'));
  log('  NEAR transfers run asynchronously. Here the vendor account no longer exists, so');
  log('  the transfer fails a block later. The vault must release the budget exactly once.\n');
  const ghost = 'old-vendor.test.near';
  await owner.call(vault, 'allow_recipient', { recipient: ghost });
  const act = { name: 'async_failure', payments: [] };
  const before = await vault.view('get_agent', { agent: research.accountId });
  const vaultBefore = await bal(vault);
  const id = `ghost-r${run}`;
  const r1 = await requestPayment(research, vault, { requestId: id, recipient: ghost, amountNear: 0.5, memo: 'annual renewal' });
  show(log, `0.5 NEAR → ${ghost}`, r1);
  act.payments.push({ requestId: id, outcome: r1.outcome, tx: r1.hash });
  const after = await vault.view('get_agent', { agent: research.accountId });
  const req = await vault.view('get_request', { key: r1.outcome.key });
  log(`      final status: ${req.status === 'Failed' ? red('Failed') : req.status}, refund returned to vault (${vaultBefore} → ${await bal(vault)} NEAR)`);
  log(`      agent budget: spent ${fmt(before.spent)} → ${fmt(after.spent)}, reserved ${fmt(before.reserved)} → ${fmt(after.reserved)}`);
  const r2 = await requestPayment(research, vault, { requestId: id, recipient: ghost, amountNear: 0.5, memo: 'retry' });
  show(log, 'agent retries with the same request id', r2);
  act.payments.push({ requestId: `${id} (retry)`, outcome: r2.outcome, tx: r2.hash });
  log('');
  return act;
}

/**
 * Act 3: a payment over the threshold waits for the owner.
 * With approve=false it is left pending (the dashboard approves it).
 */
export async function actApproval(env, { log = console.log, approve = true } = {}) {
  const { owner, vault, vendor, agents } = env;
  const buyer = agents[2];
  const run = ++runId;
  log(bold('Act 3: big payments need a human'));
  const act = { name: 'owner_approval', payments: [] };
  const id = `gpu-r${run}`;
  const r3 = await requestPayment(buyer, vault, { requestId: id, recipient: vendor.accountId, amountNear: 0.5, memo: 'GPU hours for model eval' });
  show(log, `buyer-agent: 0.5 NEAR → ${vendor.accountId} (over its 0.4 NEAR approval threshold)`, r3);
  const entry = { requestId: id, outcome: r3.outcome, tx: r3.hash };
  if (approve) {
    const ap = await owner.callRaw(vault, 'approve', { key: r3.outcome.key }, { gas: '100000000000000' });
    log(`      owner approves from their wallet   ${dim(`tx ${ap.result.transaction.hash}`)}`);
    log(`      final status: ${green((await vault.view('get_request', { key: r3.outcome.key })).status)}`);
    entry.approveTx = ap.result.transaction.hash;
  }
  act.payments.push(entry);
  log('');
  return act;
}

/**
 * Act 4: paying in USDC (NEP-141). One payment settles through ft_transfer;
 * one goes to an allowed account that never registered with the token, which
 * the vault catches before sending, so nothing is lost.
 */
export async function actUsdc(env, { log = console.log } = {}) {
  const { root, owner, vault, vendor, agents, usdc } = env;
  if (!usdc) return { name: 'usdc', payments: [] };
  const research = agents[0];
  const run = ++runId;
  log(bold('Act 4: paying in USDC'));
  log('  Same rules, separate USDC limits. Token payments check that the recipient can');
  log('  receive the token first, so a payment can\'t vanish into an unregistered account.\n');
  const act = { name: 'usdc', payments: [] };
  const ftBal = async (id) => fmtU(await usdc.view('ft_balance_of', { account_id: id }));

  const before = await ftBal(vendor.accountId);
  const id1 = `usdc-r${run}-a`;
  const r1 = await requestPayment(research, vault, { requestId: id1, recipient: vendor.accountId, amountUsdc: 7.5, token: usdc.accountId, memo: 'Inference credits, 5k calls' });
  show(log, `7.50 USDC → ${vendor.accountId}`, r1);
  log(`      vendor USDC balance: ${before} → ${await ftBal(vendor.accountId)}`);
  act.payments.push({ requestId: id1, recipient: vendor.accountId, amountUsdc: 7.5, memo: 'Inference credits, 5k calls', outcome: r1.outcome, tx: r1.hash });

  const fresh = await root.createSubAccount(`new-vendor-r${run}`, { initialBalance: N(1) });
  await owner.call(vault, 'allow_recipient', { recipient: fresh.accountId });
  const id2 = `usdc-r${run}-b`;
  const r2 = await requestPayment(research, vault, { requestId: id2, recipient: fresh.accountId, amountUsdc: 3, token: usdc.accountId, memo: 'Trial invoice' });
  show(log, `3.00 USDC → ${fresh.accountId} (allowed, but not registered with USDC)`, r2);
  const req = await vault.view('get_request', { key: r2.outcome.key });
  log(`      final status: ${red(req.status)} (${req.failure_reason}), budget released, no USDC left the vault`);
  act.payments.push({ requestId: id2, recipient: fresh.accountId, amountUsdc: 3, memo: 'Trial invoice', outcome: r2.outcome, finalStatus: req.status, failureReason: req.failure_reason, tx: r2.hash });
  log('');
  return act;
}

/**
 * Act 5: an agent buys API calls with USDC, paying each quote through the
 * vault. The vendor serves only after reading the settled payment on-chain.
 * Then someone tries to get data for free.
 */
export async function actPaidApi(env, { log = console.log, useLlm = hasCredentials() } = {}) {
  const { vault, agents, usdc, api } = env;
  if (!usdc || !api) return { name: 'paid_api', payments: [] };
  const research = agents[0];
  ++runId;
  log(bold('Act 5: agents paying for what they use'));
  log('  A weather API charges per call in USDC. It answers 402 with a price quote, the agent');
  log('  pays the quote through the vault, and the API checks the vault contract before serving.\n');
  const act = { name: 'paid_api', payments: [], served: 0 };
  let lastOk = null;

  const pay = async ({ requestId, recipient, amountUnits, token, memo }) => {
    const r = await requestPayment(research, vault, { requestId, recipient, amountUnits, token, memo });
    act.payments.push({ requestId, recipient, amountUsdc: Number(amountUnits) / 1e6, memo, outcome: r.outcome, tx: r.hash });
    return r.outcome;
  };
  const call = async ({ endpoint, city }) => {
    const url = `${api.url}${endpoint}?city=${encodeURIComponent(city)}`;
    const r = await paidFetch(url, { agentId: research.accountId, vaultId: vault.accountId, pay });
    const price = r.quote ? `${fmtU(r.quote.price)} USDC` : '';
    if (r.status === 'ok') {
      act.served += 1;
      lastOk = { endpoint, city, quote: r.quote };
      log(`    ${endpoint}?city=${city}: 402 quote ${price} → vault ${green('PAID')} → API ${green('200')}`);
      log(dim(`      ${JSON.stringify(r.data).slice(0, 96)}`));
      return { data: r.data, paid: price };
    }
    if (r.status === 'blocked') {
      log(`    ${endpoint}?city=${city}: 402 quote ${price} → vault ${red(`BLOCKED  ${r.reason}`)} → API serves nothing`);
      return { blocked: r.reason };
    }
    log(`    ${endpoint}?city=${city}: ${yellow(r.status)} ${r.error ?? ''}`);
    return { status: r.status, error: r.error };
  };

  let mode = 'scripted';
  if (useLlm) {
    try {
      log(dim(`  research agent: Claude (${MODEL})`));
      await runBuyerAgent({ call, onEvent: (e) => e.type === 'say' && log(dim(`    agent: ${e.text.split('\n')[0].slice(0, 110)}`)) });
      mode = 'llm';
    } catch (e) {
      log(yellow(`  Claude unavailable (${String(e.message).slice(0, 80)}), using the scripted agent.`));
    }
  }
  if (mode === 'scripted') {
    for (const step of BUYER_SCRIPT) {
      log(dim(`    agent: ${step.say}`));
      await call(step);
    }
  }
  act.mode = mode;

  // Someone without a paid quote tries to get data.
  log('\n  Trying to get data without paying:');
  if (lastOk) {
    const u = `${api.url}${lastOk.endpoint}?city=${encodeURIComponent(lastOk.city)}`;
    const replay = await fetch(u, { headers: { 'x-banbo-payment': `${research.accountId}:${lastOk.quote.id}` } });
    log(`    reuse a quote that was already paid for → API ${red(replay.status)} ${(await replay.json()).error}`);
    act.replay = replay.status;
  }
  const q = await (await fetch(`${api.url}/v1/forecast?city=Faro`)).json();
  const free = await fetch(`${api.url}/v1/forecast?city=Faro`, { headers: { 'x-banbo-payment': `${research.accountId}:${q.quote.id}` } });
  log(`    claim a fresh quote was paid when it wasn't → API ${red(free.status)} ${(await free.json()).error}`);
  act.unpaid = free.status;
  log(dim(`\n  vendor: ${api.stats.served} calls served, ${api.stats.refused} refused, every one checked against the vault contract`));
  log('');
  return act;
}

/** Normal agent traffic: small legitimate payments to the vendor. */
export async function actRoutine(env, { log = console.log, count = 3 } = {}) {
  const { vault, vendor, agents, usdc } = env;
  const run = ++runId;
  const memos = ['Weather API: forecast calls', 'Geocoding API top-up', 'Vector DB storage, November'];
  const act = { name: 'routine', payments: [] };
  for (let i = 0; i < count; i++) {
    const agent = agents[i % 2];
    const amountNear = [0.12, 0.05, 0.08][i % 3];
    const r = await requestPayment(agent, vault, { requestId: `routine-r${run}-${i}`, recipient: vendor.accountId, amountNear, memo: memos[i % 3] });
    show(log, `${agent.accountId}: ${amountNear} NEAR → ${vendor.accountId}`, r);
    act.payments.push({ recipient: vendor.accountId, amountNear, memo: memos[i % 3], outcome: r.outcome, tx: r.hash });
  }
  if (usdc) {
    const memo = 'Search API, monthly plan';
    const r = await requestPayment(agents[1], vault, { requestId: `routine-r${run}-usdc`, recipient: vendor.accountId, amountUsdc: 2.4, token: usdc.accountId, memo });
    show(log, `${agents[1].accountId}: 2.40 USDC → ${vendor.accountId}`, r);
    act.payments.push({ recipient: vendor.accountId, amountUsdc: 2.4, memo, outcome: r.outcome, tx: r.hash });
  }
  return act;
}
