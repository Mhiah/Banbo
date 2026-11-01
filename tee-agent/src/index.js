// Banbo TEE agent: runs inside a dstack confidential VM (Intel TDX), e.g. on
// Phala Cloud or NEAR AI's TEE infrastructure.
//
// On start it:
//   1. gets its NEAR key from dstack's KMS and prints its implicit account;
//   2. prints the measurement the vault owner approves in the dashboard;
//   3. waits until the owner has added the account as an agent and funded it
//      with a little NEAR for gas;
//   4. attests to the vault (TDX quote verified by the contract) and re-attests
//      before the attestation runs out.
// It then serves:
//   GET  /status        account, attestation, measurement (public)
//   GET  /attestation   measurement + latest quote, for anyone to verify (public)
//   POST /task          {"task": "..."} runs the agent (needs AGENT_TASK_TOKEN)
//
// Configuration (set as encrypted secrets in the TEE deployment):
//   NEAR_NETWORK=testnet|mainnet  VAULT_ID  NEAR_RPC (optional)
//   NEAR_AI_API_KEY  NEAR_AI_MODEL  NEAR_AI_BASE_URL (optional)
//   AGENT_TASK_TOKEN  HIDDEN_VENDORS='{"vendor.near":"<salt>"}' (from the dashboard)
import http from 'node:http';
import crypto from 'node:crypto';
import { DstackClient } from '@phala/dstack-sdk';
import { getCollateral, PHALA_PCCS_URL } from '@phala/dcap-qvl';
import { agentKey, buildAttestation } from './tee.js';
import { openVault } from './vault.js';
import { toolHandlers, runTask, nearAiChat } from './agent.js';

const env = process.env;
const network = env.NEAR_NETWORK || 'testnet';
const nodeUrl = env.NEAR_RPC || (network === 'mainnet' ? 'https://rpc.mainnet.near.org' : 'https://rpc.testnet.near.org');
const vaultId = env.VAULT_ID;
const port = Number(env.PORT || 8080);
const log = (...a) => console.log(new Date().toISOString(), ...a);
if (!vaultId) throw new Error('VAULT_ID is required');

const salts = env.HIDDEN_VENDORS ? JSON.parse(env.HIDDEN_VENDORS) : {};
const client = new DstackClient();
const { keyPair, accountId } = await agentKey(client);
const vault = await openVault({ networkId: network, nodeUrl, vaultId, accountId, keyPair });
const getColl = (quote) => getCollateral(env.PCCS_URL || PHALA_PCCS_URL, quote);

const state = { accountId, vaultId, network, attested: null, measurement: null, lastQuote: null, lastError: null };
const first = await buildAttestation(client, accountId, getColl);
state.measurement = first.measurement;
state.lastQuote = first.attestation.quote;
log(`agent account: ${accountId}`);
log(`measurement for the vault owner to approve:\n${JSON.stringify(first.measurement, null, 2)}`);

const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

async function attestLoop() {
  for (;;) {
    try {
      const [agent, bal] = await Promise.all([vault.view('get_agent', { agent: accountId }), vault.balance()]);
      if (!agent) { state.lastError = 'waiting for the owner to add this account as an agent'; await sleep(30_000); continue; }
      if (bal < 10n ** 23n) { state.lastError = 'waiting for at least 0.1 NEAR for gas'; await sleep(30_000); continue; }
      const { attestation, measurement } = await buildAttestation(client, accountId, getColl);
      state.measurement = measurement;
      state.lastQuote = attestation.quote;
      await vault.attest(attestation);
      state.attested = await vault.view('get_agent_tee', { agent: accountId });
      state.lastError = null;
      log(`attested until ${new Date(state.attested.valid_until_ms).toISOString()}`);
      const ttl = state.attested.valid_until_ms - Date.now();
      await sleep(Math.max(60_000, ttl / 2));
    } catch (e) {
      state.lastError = String(e.message ?? e).slice(0, 400);
      log(`attestation failed: ${state.lastError}`);
      await sleep(60_000);
    }
  }
}
attestLoop();

const chat = env.NEAR_AI_API_KEY && env.NEAR_AI_MODEL
  ? nearAiChat({ apiKey: env.NEAR_AI_API_KEY, model: env.NEAR_AI_MODEL, baseUrl: env.NEAR_AI_BASE_URL })
  : null;
const handlers = toolHandlers({ vault, vaultId, salts });
let busy = false;

const send = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body, null, 2)); };
const authorized = (req) => {
  const want = env.AGENT_TASK_TOKEN;
  const got = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
  return want && got.length === want.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
};

http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/status') {
      return send(res, 200, { ...state, lastQuote: undefined, hiddenVendors: Object.keys(salts).length, inference: chat ? `near-ai:${env.NEAR_AI_MODEL}` : 'not configured' });
    }
    if (req.method === 'GET' && req.url === '/attestation') {
      return send(res, 200, { account: accountId, report_data: `${accountId}${'0'.repeat(64)}`, measurement: state.measurement, quote: state.lastQuote });
    }
    if (req.method === 'POST' && req.url === '/task') {
      if (!authorized(req)) return send(res, 401, { error: 'unauthorized' });
      if (!chat) return send(res, 503, { error: 'NEAR_AI_API_KEY and NEAR_AI_MODEL are not set' });
      if (busy) return send(res, 409, { error: 'a task is already running' });
      let body = '';
      for await (const c of req) { body += c; if (body.length > 20_000) return send(res, 413, { error: 'too large' }); }
      const { task } = JSON.parse(body || '{}');
      if (!task) return send(res, 400, { error: 'task is required' });
      busy = true;
      try {
        const events = [];
        const r = await runTask(task, { handlers, chat, onEvent: (e) => events.push(e) });
        return send(res, 200, { summary: r.summary, actions: events });
      } finally { busy = false; }
    }
    send(res, 404, { error: 'not found' });
  } catch (e) {
    busy = false;
    send(res, 500, { error: String(e.message ?? e).slice(0, 300) });
  }
}).listen(port, () => log(`listening on :${port}`));
