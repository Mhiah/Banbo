// Long-running local NEAR node with a seeded Banbo vault, for the dashboard.
//
//   npm run sandbox
//
// Serves a small local API on http://localhost:3031 (localhost only):
//   GET  /config           network + account ids for the dashboard
//   POST /call             {method, args, gas?, deposit?} signed as the vault owner
//   POST /scenario/:name   injection | failure | approval | routine
// Signing keys never leave this process.
import http from 'node:http';
import { setupVault } from './vault.js';
import { actInjection, actFailedTransfer, actApproval, actRoutine, bold, cyan, dim } from './acts.js';
import { hasCredentials } from './agent.js';

const PORT = Number(process.env.SANDBOX_API_PORT || 3031);
const log = (...a) => console.log(...a);

log(bold('\nBanbo local sandbox\n'));
log(dim('Starting a local NEAR node and deploying the vault...'));
const env = await setupVault();
const { worker, owner, vault, vendor, attacker, agents } = env;
const rpcUrl = worker.provider.connection.url;

// A little history so the dashboard isn't empty on first load.
await actRoutine(env, { log: () => {} });

const config = {
  network: 'sandbox',
  nodeUrl: rpcUrl,
  contractId: vault.accountId,
  owner: owner.accountId,
  agents: agents.map((a) => a.accountId),
  vendor: vendor.accountId,
  attacker: attacker.accountId,
  llmAgent: hasCredentials(),
};

let busy = false;
const scenarios = {
  injection: () => actInjection(env, { log }),
  failure: () => actFailedTransfer(env, { log }),
  approval: () => actApproval(env, { log, approve: false }),
  routine: () => actRoutine(env, { log }),
};

const send = (res, code, body) => {
  res.writeHead(code, {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type',
  });
  res.end(JSON.stringify(body));
};
const readBody = (req) => new Promise((ok) => {
  let d = '';
  req.on('data', (c) => (d += c));
  req.on('end', () => { try { ok(d ? JSON.parse(d) : {}); } catch { ok({}); } });
});

const OWNER_METHODS = new Set([
  'add_agent', 'set_agent_active', 'allow_recipient', 'disallow_recipient', 'set_shared_cap',
  'pause', 'unpause', 'approve', 'decline', 'withdraw', 'deposit',
]);

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204, {});
  try {
    if (req.method === 'GET' && req.url === '/config') return send(res, 200, config);
    if (req.method === 'POST' && req.url === '/call') {
      const { method, args = {}, deposit } = await readBody(req);
      if (!OWNER_METHODS.has(method)) return send(res, 400, { error: `method not allowed: ${method}` });
      const r = await owner.callRaw(vault, method, args, { gas: '100000000000000', attachedDeposit: deposit ?? '0' });
      const failure = r.failures?.[0];
      return send(res, failure ? 400 : 200, {
        hash: r.result.transaction.hash,
        error: failure ? JSON.stringify(failure) : undefined,
      });
    }
    const m = req.url.match(/^\/scenario\/(\w+)$/);
    if (req.method === 'POST' && m && scenarios[m[1]]) {
      if (busy) return send(res, 409, { error: 'a scenario is already running' });
      busy = true;
      try {
        log('');
        const act = await scenarios[m[1]]();
        return send(res, 200, act);
      } finally {
        busy = false;
      }
    }
    send(res, 404, { error: 'not found' });
  } catch (e) {
    busy = false;
    send(res, 500, { error: String(e.message ?? e).slice(0, 500) });
  }
});
server.listen(PORT, '127.0.0.1', () => {
  log(`  node      ${cyan(rpcUrl)}`);
  log(`  vault     ${cyan(vault.accountId)}`);
  log(`  owner     ${owner.accountId}`);
  log(`  agents    ${agents.map((a) => a.accountId).join(', ')}`);
  log(`  api       ${cyan(`http://localhost:${PORT}`)}`);
  log(dim('\nOpen the dashboard (cd dashboard && npm run dev) and choose "Local sandbox".'));
  log(dim('Press Ctrl+C to stop.\n'));
});

const stop = async () => { server.close(); await worker.tearDown(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
