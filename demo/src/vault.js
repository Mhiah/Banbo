// Shared helpers: start a local NEAR sandbox, deploy Banbo, seed policy.
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
export const WASM = path.resolve(here, '../../contract/res/banbo.wasm');
/** Test-only NEP-141 token standing in for USDC on the sandbox. */
export const FT_WASM = path.resolve(here, '../../contract/res/mock_ft.wasm');

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

/** USDC (number, up to 6 decimals) -> smallest-unit string */
export const U = (usdc) => BigInt(Math.round(usdc * 1e6)).toString();
/** smallest-unit string -> "1.50" USDC */
export const fmtU = (units) => {
  const v = BigInt(units);
  return `${v / 1_000_000n}.${((v % 1_000_000n) / 10_000n).toString().padStart(2, '0')}`;
};

export const DAY_MS = 86_400_000;
const TGAS = (n) => (BigInt(n) * 10n ** 12n).toString();

/**
 * Sandbox with: owner, a funded vault (10 NEAR usable), three agents,
 * an allowlisted API vendor, an attacker account, and a test USDC token
 * (500 USDC in the vault, 100 USDC shared daily cap).
 */
export async function setupVault({ vaultNear = 11, sharedCap = 5, usdc = true } = {}) {
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
  const token = usdc ? await setupUsdc({ root, owner, vault, vendor, agents }) : null;
  return { worker, root, owner, vault, vendor, attacker, agents, usdc: token };
}

/**
 * Deploy the test USDC token, register the vault and the vendor with it,
 * fund the vault with 500 USDC through ft_transfer_call (the real NEP-141
 * deposit path), and give agents USDC limits.
 */
async function setupUsdc({ root, owner, vault, vendor, agents }) {
  const usdc = await root.createSubAccount('usdc', { initialBalance: N(10) });
  await usdc.deploy(FT_WASM);
  await usdc.call(usdc, 'new', { symbol: 'USDC', decimals: 6 });
  for (const acct of [vault, vendor]) {
    await owner.call(usdc, 'storage_deposit', { account_id: acct.accountId }, { attachedDeposit: N(0.01) });
  }
  await usdc.call(usdc, 'mint', { account_id: owner.accountId, amount: U(1000) });
  await owner.call(vault, 'add_token', { token: usdc.accountId, symbol: 'USDC', decimals: 6, shared_cap: U(100) });
  await owner.call(usdc, 'ft_transfer_call', { receiver_id: vault.accountId, amount: U(500), msg: '' },
    { attachedDeposit: '1', gas: TGAS(100) });
  // research + ops: 10 USDC per payment, 40 a day. buyer: approval above 15.
  const limits = [[agents[0], 10, 40, 10], [agents[1], 10, 40, 10], [agents[2], 25, 60, 15]];
  for (const [a, perTx, period, threshold] of limits) {
    await owner.call(vault, 'set_agent_token_limits', {
      agent: a.accountId, token: usdc.accountId, per_tx_max: U(perTx), period_limit: U(period), approval_threshold: U(threshold),
    });
  }
  return usdc;
}

/** Call request_payment and return { outcome, hash, logs }. */
/** Pass amountNear for NEAR, or token + amountUsdc for the test USDC. */
export async function requestPayment(agent, vault, { requestId, recipient, amountNear, amountUsdc, token, memo }) {
  const amount = token ? U(amountUsdc) : N(amountNear);
  const res = await agent.callRaw(vault, 'request_payment', {
    request_id: requestId, recipient, amount, memo, token: token ?? null,
  }, { gas: TGAS(150) });
  return {
    outcome: res.parseResult(),
    hash: res.result.transaction.hash,
    logs: res.logs,
    raw: res,
  };
}

/** Parse Banbo NEP-297 events from logs. */
export function events(logs) {
  return logs
    .filter((l) => l.startsWith('EVENT_JSON:'))
    .map((l) => JSON.parse(l.slice('EVENT_JSON:'.length)))
    .filter((e) => e.standard === 'banbo');
}
