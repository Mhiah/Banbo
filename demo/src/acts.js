// The demo's three acts, shared by the CLI demo and the sandbox server that
// backs the dashboard. Every payment is a real transaction on the node.
import { requestPayment, events, fmt } from './vault.js';
import { runLlmAgent, hasCredentials, COMPROMISED_SCRIPT, MODEL, INVOICE_URL } from './agent.js';

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
  return act;
}

/** Normal agent traffic: small legitimate payments to the vendor. */
export async function actRoutine(env, { log = console.log, count = 3 } = {}) {
  const { vault, vendor, agents } = env;
  const run = ++runId;
  const memos = ['Weather API: forecast calls', 'Geocoding API top-up', 'Vector DB storage, November'];
  const act = { name: 'routine', payments: [] };
  for (let i = 0; i < count; i++) {
    const agent = agents[i % 2];
    const amountNear = [0.12, 0.05, 0.08][i % 3];
    const r = await requestPayment(agent, vault, { requestId: `routine-r${run}-${i}`, recipient: vendor.accountId, amountNear, memo: memos[i % 3] });
    show(log, `${agent.accountId}: ${amountNear} NEAR → ${vendor.accountId}`, r);
    act.payments.push({ outcome: r.outcome, tx: r.hash });
  }
  return act;
}
