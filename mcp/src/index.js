#!/usr/bin/env node
// Banbo MCP server (stdio). Lets an AI agent pay through a Banbo vault.
//
//   BANBO_VAULT            the vault contract account (required)
//   BANBO_AGENT_ACCOUNT    the agent's account (required)
//   BANBO_AGENT_KEY        the agent's function-call private key, "ed25519:..."
//     or BANBO_CREDENTIALS_FILE  a near-cli credentials JSON with private_key
//   BANBO_NETWORK          testnet (default) or mainnet
//   BANBO_RPC              RPC URL (default: FastNEAR for the network)
//   BANBO_RECIPIENT_SALTS  JSON {"vendor.near": "<salt>"} for hidden vendors
//   BANBO_ALLOW_FULL_ACCESS_KEY=1  accept a full-access key (local testing only)
//
// Logs go to stderr; stdout carries the MCP protocol.
import fs from 'node:fs';
import { KeyPair } from 'near-api-js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { openVault } from './vault.js';
import { createServer } from './tools.js';

const env = process.env;
const die = (msg) => { console.error(`banbo-mcp: ${msg}`); process.exit(1); };

const networkId = env.BANBO_NETWORK || 'testnet';
if (!['testnet', 'mainnet', 'sandbox', 'localnet'].includes(networkId)) die(`unknown BANBO_NETWORK "${networkId}"`);
// Public RPC nodes, tried in order; the first that answers is used. BANBO_RPC
// (one URL, or several separated by commas) replaces the list.
const PUBLIC_RPC = {
  testnet: ['https://archival-rpc.testnet.fastnear.com', 'https://test.rpc.fastnear.com', 'https://rpc.testnet.near.org'],
  mainnet: ['https://rpc.mainnet.fastnear.com', 'https://free.rpc.fastnear.com', 'https://rpc.mainnet.near.org'],
};
const rpcUrls = env.BANBO_RPC ? env.BANBO_RPC.split(',').map((u) => u.trim()).filter(Boolean)
  : PUBLIC_RPC[networkId] ?? die('set BANBO_RPC for a local network');
const vaultId = env.BANBO_VAULT || die('set BANBO_VAULT to the vault account');
const accountId = env.BANBO_AGENT_ACCOUNT || die('set BANBO_AGENT_ACCOUNT to the agent account');

let secret = env.BANBO_AGENT_KEY;
if (!secret && env.BANBO_CREDENTIALS_FILE) {
  const creds = JSON.parse(fs.readFileSync(env.BANBO_CREDENTIALS_FILE, 'utf8'));
  if (creds.account_id && creds.account_id !== accountId) die(`the credentials file is for ${creds.account_id}, not ${accountId}`);
  secret = creds.private_key ?? creds.secret_key;
}
if (!secret) die('set BANBO_AGENT_KEY or BANBO_CREDENTIALS_FILE');
let keyPair;
try { keyPair = KeyPair.fromString(secret); } catch { die('the agent key is not a valid NEAR private key'); }
secret = null;

let salts = {};
if (env.BANBO_RECIPIENT_SALTS) {
  try { salts = JSON.parse(env.BANBO_RECIPIENT_SALTS); } catch { die('BANBO_RECIPIENT_SALTS must be JSON'); }
}

const nodeUrl = rpcUrls.length === 1 ? rpcUrls[0] : await pickNode(rpcUrls);

/** The first node that answers a status request. */
async function pickNode(urls) {
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'status', params: [] }),
        signal: AbortSignal.timeout(8000),
      });
      if (res.ok && (await res.json()).result) return url;
      console.error(`banbo-mcp: ${url} answered ${res.status}, trying the next node`);
    } catch (e) {
      console.error(`banbo-mcp: can't reach ${url} (${e.message}), trying the next node`);
    }
  }
  die(`none of these RPC nodes answered: ${urls.join(', ')}. Set BANBO_RPC to one that works`);
}

let vault;
try {
  vault = await openVault({ networkId, nodeUrl, vaultId, accountId, keyPair, allowFullAccess: env.BANBO_ALLOW_FULL_ACCESS_KEY === '1' });
} catch (e) {
  die(`can't use this key: ${e.message}`);
}
console.error(`banbo-mcp: ${accountId} → vault ${vaultId} on ${networkId} via ${nodeUrl}; ${vault.keyInfo}`);

const server = createServer({ vault, salts });
await server.connect(new StdioServerTransport());
