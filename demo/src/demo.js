// One-command demo: starts a local NEAR node, deploys Banbo and runs
// three acts. Every payment below is a real transaction against the contract.
//
//   npm run demo              # uses Claude if ANTHROPIC_API_KEY is set, else scripted agent
//   npm run demo -- --scripted
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupVault, fmt } from './vault.js';
import { hasCredentials, MODEL } from './agent.js';
import { actInjection, actFailedTransfer, actApproval, bold, cyan, dim } from './acts.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const useLlm = hasCredentials() && !process.argv.includes('--scripted');
const log = (...a) => console.log(...a);

async function main() {
  log(bold('\nBanbo: the wallet firewall for AI agents on NEAR\n'));
  log(dim('Starting a local NEAR node and deploying the vault...'));
  const env = await setupVault();
  const { worker, vault } = env;
  const report = { startedAt: new Date().toISOString(), agentMode: useLlm ? `llm:${MODEL}` : 'scripted', acts: [] };
  try {
    log(`  vault ${cyan(vault.accountId)} holds ${fmt((await vault.balance()).total.toString())} NEAR`);
    log(`  policy: allowlist = [${(await vault.view('list_allowlist', {})).join(', ')}], 0.5 NEAR per request, 3 NEAR/agent/day, 5 NEAR shared/day\n`);
    report.acts.push(await actInjection(env, { log, useLlm }));
    report.acts.push(await actFailedTransfer(env, { log }));
    report.acts.push(await actApproval(env, { log }));

    const b = await vault.view('get_balances', {});
    log(bold('\nFinal state (read from the contract)'));
    log(`  shared spent ${fmt(b.shared_spent)} + reserved ${fmt(b.shared_reserved)} ≤ cap ${fmt(b.shared_cap)}`);
    log(`  in flight ${fmt(b.in_flight)}, pending approval ${fmt(b.pending_approval)}, available ${fmt(b.available)} NEAR`);
    log(`  blocked attempts recorded on-chain: ${await vault.view('blocked_count', {})}`);
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
