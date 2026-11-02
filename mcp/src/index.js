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
const nodeUrl = env.BANBO_RPC || (networkId === 'mainnet' ? 'https://rpc.mainnet.fastnear.com' : networkId === 'testnet' ? 'https://rpc.testnet.fastnear.com' : die('set BANBO_RPC for a local network'));
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

let vault;
try {
  vault = await openVault({ networkId, nodeUrl, vaultId, accountId, keyPair, allowFullAccess: env.BANBO_ALLOW_FULL_ACCESS_KEY === '1' });
} catch (e) {
  die(`can't use this key: ${e.message}`);
}
console.error(`banbo-mcp: ${accountId} → vault ${vaultId} on ${networkId}; ${vault.keyInfo}`);

const server = createServer({ vault, salts });
await server.connect(new StdioServerTransport());
