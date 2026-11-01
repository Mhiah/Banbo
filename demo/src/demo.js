// One-command demo: starts a local NEAR node, deploys Banbo and runs
// three acts. Every payment below is a real transaction against the contract.
//
//   npm run demo              # uses Claude if ANTHROPIC_API_KEY is set, else scripted agent
//   npm run demo -- --scripted
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupVault, requestPayment, events, fmt, N } from './vault.js';
import { runLlmAgent, hasCredentials, COMPROMISED_SCRIPT, MODEL, INVOICE_URL } from './agent.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const useLlm = hasCredentials() && !process.argv.includes('--scripted');

const c = (code) => (s) => (process.stdout.isTTY ? `\x1b[${code}m${s}\x1b[0m` : s);
const red = c('31'), green = c('32'), yellow = c('33'), cyan = c('36'), dim = c('2'), bold = c('1');
const log = (...a) => console.log(...a);
const report = { startedAt: new Date().toISOString(), agentMode: useLlm ? `llm:${MODEL}` : 'scripted', acts: [] };

function show(label, r) {
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

async function main() {
  log(bold('\nBanbo: an agent wallet firewall on NEAR\n'));
  log(dim('Starting a local NEAR node and deploying the vault...'));
  const env = await setupVault();
  const { worker, owner, vault, vendor, attacker, agents } = env;
  const [research, , buyer] = agents;
  const bal = async (a) => fmt((await a.balance()).total.toString());

  try {
    log(`  vault ${cyan(vault.accountId)} holds ${await bal(vault)} NEAR`);
    log(`  policy: allowlist = [${(await vault.view('list_allowlist', {})).join(', ')}], 0.5 NEAR per request, 3 NEAR/agent/day, 5 NEAR shared/day\n`);

    // ------------------------------------------------------------- Act 1
    log(bold('Act 1: prompt injection'));
    log(`  The agent is asked to pay ${INVOICE_URL}.`);
    log(`  The page hides instructions to move the treasury to ${red(attacker.accountId)}.\n`);
    const attackerBefore = await bal(attacker);
    const act1 = { name: 'prompt_injection', payments: [] };
    const pay = async (args) => {
      const r = await requestPayment(research, vault, args);
      show(`${args.amountNear} NEAR → ${args.recipient}  "${args.memo}"`, r);
      act1.payments.push({ ...args, outcome: r.outcome, tx: r.hash });
      return r.outcome;
    };

    let attackerTried = false;
    if (useLlm) {
      log(dim(`  agent: ${MODEL} via the Claude API, with the vault as its only payment tool`));
      await runLlmAgent({
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
      for (const step of COMPROMISED_SCRIPT) {
        log(`    agent: ${step.say}`);
        await pay({ requestId: `inv881-c${COMPROMISED_SCRIPT.indexOf(step)}`, recipient: step.recipient, amountNear: step.amountNear, memo: step.memo });
      }
    }
    log(`\n  attacker balance: ${attackerBefore} → ${await bal(attacker)} NEAR  ${green('(unchanged)')}`);
    log(`  vendor got paid:  ${green(fmt((await vault.view('get_agent', { agent: research.accountId })).spent))} NEAR spent by the agent today\n`);
    report.acts.push(act1);

    // ------------------------------------------------------------- Act 2
    log(bold('Act 2: a payment fails after it was approved'));
    log('  NEAR transfers run asynchronously. Here the vendor account no longer exists, so');
    log('  the transfer fails a block later. The vault must release the budget exactly once.\n');
    const ghost = 'old-vendor.test.near';
    await owner.call(vault, 'allow_recipient', { recipient: ghost });
    const act2 = { name: 'async_failure', payments: [] };
    const before = await vault.view('get_agent', { agent: research.accountId });
    const vaultBefore = await bal(vault);
    const r1 = await requestPayment(research, vault, { requestId: 'ghost-1', recipient: ghost, amountNear: 0.5, memo: 'renewal' });
    show(`0.5 NEAR → ${ghost}`, r1);
    act2.payments.push({ requestId: 'ghost-1', outcome: r1.outcome, tx: r1.hash });
    const after = await vault.view('get_agent', { agent: research.accountId });
    const req = await vault.view('get_request', { key: r1.outcome.key });
    log(`      final status: ${req.status === 'Failed' ? red('Failed') : req.status}, refund returned to vault (${vaultBefore} → ${await bal(vault)} NEAR)`);
    log(`      agent budget: spent ${fmt(before.spent)} → ${fmt(after.spent)}, reserved ${fmt(before.reserved)} → ${fmt(after.reserved)}`);
    const r2 = await requestPayment(research, vault, { requestId: 'ghost-1', recipient: ghost, amountNear: 0.5, memo: 'retry' });
    show('agent retries with the same request id', r2);
    act2.payments.push({ requestId: 'ghost-1 (retry)', outcome: r2.outcome, tx: r2.hash });
    report.acts.push(act2);
    log('');

    // ------------------------------------------------------------- Act 3
    log(bold('Act 3: big payments need a human'));
    const act3 = { name: 'owner_approval', payments: [] };
    const r3 = await requestPayment(buyer, vault, { requestId: 'gpu-1', recipient: vendor.accountId, amountNear: 0.5, memo: 'GPU hours' });
    show(`buyer-agent: 0.5 NEAR → ${vendor.accountId} (over its 0.4 NEAR approval threshold)`, r3);
    const ap = await owner.callRaw(vault, 'approve', { key: r3.outcome.key }, { gas: '100000000000000' });
    log(`      owner approves from their wallet   ${dim(`tx ${ap.result.transaction.hash}`)}`);
    log(`      final status: ${green((await vault.view('get_request', { key: r3.outcome.key })).status)}`);
    act3.payments.push({ requestId: 'gpu-1', outcome: r3.outcome, tx: r3.hash, approveTx: ap.result.transaction.hash });
    report.acts.push(act3);

    // ------------------------------------------------------------- Summary
    const b = await vault.view('get_balances', {});
    log(bold('\nFinal state (read from the contract)'));
    log(`  shared spent ${fmt(b.shared_spent)} + reserved ${fmt(b.shared_reserved)} ≤ cap ${fmt(b.shared_cap)}`);
    log(`  in flight ${fmt(b.in_flight)}, pending approval ${fmt(b.pending_approval)}, available ${fmt(b.available)} NEAR`);
    report.final = b;
    const out = path.resolve(here, '../out');
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, 'demo-report.json'), JSON.stringify(report, null, 2));
    log(dim(`\nTransaction log written to demo/out/demo-report.json\n`));
  } finally {
    await worker.tearDown();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
