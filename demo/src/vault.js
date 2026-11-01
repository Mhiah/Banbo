// Shared helpers: start a local NEAR sandbox, deploy AtomicGuard, seed policy.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pkg from 'near-workspaces';
import { createRequire } from 'node:module';
const { Worker } = pkg;
const { Logger } = createRequire(import.meta.url)('@near-js/utils');

// Keep output readable: the demo prints its own timeline. Set
// NEAR_PRINT_LOGS=1 to see raw receipts and contract logs.
if (!process.env.NEAR_PRINT_LOGS) {
  process.env.NEAR_WORKSPACES_NO_LOGS = '1';
  Logger.overrideLogger(undefined);
}

const here = path.dirname(fileURLToPath(import.meta.url));
export const WASM = path.resolve(here, '../../contract/res/atomicguard.wasm');

export const YOCTO = 10n ** 24n;
/** NEAR (number, up to 3 decimals) -> yoctoNEAR string */
export const N = (near) => (BigInt(Math.round(near * 1000)) * 10n ** 21n).toString();
/** yoctoNEAR string -> "1.234" */
export const fmt = (yocto) => {
  const v = BigInt(yocto);
  const whole = v / YOCTO;
  const frac = ((v % YOCTO) * 1000n) / YOCTO;
  return `${whole}.${frac.toString().padStart(3, '0')}`;
};

export const DAY_MS = 86_400_000;

/**
 * Sandbox with: owner, a funded vault (10 NEAR usable), three agents,
 * an allowlisted API vendor, and an attacker account.
 */
export async function setupVault({ vaultNear = 11, sharedCap = 5 } = {}) {
  const worker = await Worker.init();
  const root = worker.rootAccount;
  const owner = await root.createSubAccount('owner', { initialBalance: N(50) });
  const vendor = await root.createSubAccount('api-vendor', { initialBalance: N(5) });
  const attacker = await root.createSubAccount('attacker', { initialBalance: N(5) });
  const agents = [];
  for (const name of ['research-agent', 'ops-agent', 'buyer-agent']) {
    agents.push(await root.createSubAccount(name, { initialBalance: N(5) }));
  }
  const vault = await root.createSubAccount('vault', { initialBalance: N(vaultNear) });
  await vault.deploy(WASM);
  await vault.call(vault, 'new', { owner: owner.accountId, period_ms: DAY_MS, shared_cap: N(sharedCap) });

  // research + ops: 0.5 per request, 3 per day, no approval needed.
  // buyer: approval needed above 0.4.
  const limits = [
    [agents[0], 0.5, 3, 0.5],
    [agents[1], 0.5, 3, 0.5],
    [agents[2], 0.5, 3, 0.4],
  ];
  for (const [a, perTx, period, threshold] of limits) {
    await owner.call(vault, 'add_agent', {
      agent: a.accountId, per_tx_max: N(perTx), period_limit: N(period), approval_threshold: N(threshold),
    });
  }
  await owner.call(vault, 'allow_recipient', { recipient: vendor.accountId });
  return { worker, root, owner, vault, vendor, attacker, agents };
}

/** Call request_payment and return { outcome, hash, logs }. */
export async function requestPayment(agent, vault, { requestId, recipient, amountNear, memo }) {
  const res = await agent.callRaw(vault, 'request_payment', {
    request_id: requestId, recipient, amount: N(amountNear), memo,
  }, { gas: '100000000000000' });
  return {
    outcome: res.parseResult(),
    hash: res.result.transaction.hash,
    logs: res.logs,
    raw: res,
  };
}

/** Parse AtomicGuard NEP-297 events from logs. */
export function events(logs) {
  return logs
    .filter((l) => l.startsWith('EVENT_JSON:'))
    .map((l) => JSON.parse(l.slice('EVENT_JSON:'.length)))
    .filter((e) => e.standard === 'atomicguard');
}
