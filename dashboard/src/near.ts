// Talking to the Banbo contract: read via JSON-RPC, write via the wallet
// (testnet/mainnet) or via the local sandbox API (keys stay in that process).
import type { WalletSelector } from '@near-wallet-selector/core';
import type { WalletSelectorModal } from '@near-wallet-selector/modal-ui';
import { actionCreators } from '@near-js/transactions';

export type NetworkId = 'sandbox' | 'testnet' | 'mainnet';

export const NETWORKS: Record<NetworkId, { label: string; nodeUrl: string; explorer?: string }> = {
  sandbox: { label: 'Local sandbox', nodeUrl: '' },
  testnet: { label: 'Testnet', nodeUrl: 'https://archival-rpc.testnet.fastnear.com', explorer: 'https://testnet.nearblocks.io' },
  mainnet: { label: 'Mainnet', nodeUrl: 'https://rpc.mainnet.fastnear.com', explorer: 'https://nearblocks.io' },
};

/** Other public RPC nodes to try, in order, when a network's node can't be reached. */
const FALLBACKS: Record<string, string[]> = {
  [NETWORKS.testnet.nodeUrl]: ['https://test.rpc.fastnear.com', 'https://rpc.testnet.near.org'],
  [NETWORKS.mainnet.nodeUrl]: ['https://free.rpc.fastnear.com', 'https://rpc.mainnet.near.org'],
};
/** The node that last answered, per network, so we don't retry a dead one on every read. */
const working = new Map<string, string>();

export const SANDBOX_API = import.meta.env.VITE_SANDBOX_API ?? 'http://localhost:3031';
/** A public build (e.g. GitHub Pages): no local sandbox, no dev Demo page. */
export const HOSTED = import.meta.env.VITE_HOSTED === '1';
/** The Banbo factory per network: creates vaults as `<name>.<factory>`. */
export const FACTORY: Partial<Record<NetworkId, string>> = {
  testnet: import.meta.env.VITE_FACTORY_TESTNET ?? 'banbo-vaults.testnet',
  ...(import.meta.env.VITE_FACTORY_MAINNET ? { mainnet: import.meta.env.VITE_FACTORY_MAINNET as string } : {}),
};
/** Networks this build offers. */
export const NETWORK_IDS: NetworkId[] = HOSTED ? ['testnet', 'mainnet'] : ['sandbox', 'testnet', 'mainnet'];

// ------------------------------------------------------------------ types

export interface Agent {
  per_tx_max: string;
  period_limit: string;
  approval_threshold: string;
  active: boolean;
  period_index: number;
  spent: string;
  reserved: string;
}
/** Where a value came from, as labelled by the agent's origin runtime. */
export type Origin = { kind: 'owner' } | { kind: 'source'; source: string; digest: string };
export interface PaymentOrigin {
  task_id: string;
  recipient: Origin;
  amount: Origin;
}
/** A job the owner gave an agent (origin-checked payments). */
export interface Task {
  id: string;
  agent: string;
  description: string;
  payees: string[];
  token: string | null;
  budget: string;
  max_per_payment: string;
  trusted_sources: string[];
  spent: string;
  reserved: string;
  created_at_ms: number;
  expires_at_ms: number;
  closed: boolean;
}
export type Status = 'PendingApproval' | 'InFlight' | 'Settled' | 'Failed' | 'Declined' | 'Expired';
export interface PaymentRequest {
  key: string;
  agent: string;
  request_id: string;
  recipient: string;
  amount: string;
  /** NEP-141 token contract, or null for NEAR. */
  token: string | null;
  memo: string;
  /** Set when paid to a hidden-allowlist recipient. */
  recipient_fingerprint: string | null;
  status: Status;
  failure_reason: string | null;
  period_index: number;
  created_at_ms: number;
  dispatched_at_ms: number | null;
  /** Pending approvals: the owner must decide before this time. */
  expires_at_ms: number | null;
  seq: number;
  /** Origin labels, for payments made under a task. */
  origin?: PaymentOrigin | null;
  /** over_approval_threshold or amount_from_untrusted_source */
  hold_reason?: string | null;
  /** "tee" or "owner_vouched" */
  label_trust?: string | null;
}
export interface BlockedAttempt {
  agent: string;
  request_id: string;
  recipient: string;
  amount: string;
  token: string | null;
  reason: string;
  memo: string;
  at_ms: number;
  origin?: PaymentOrigin | null;
}
export interface Limits {
  per_tx_max: string;
  period_limit: string;
  approval_threshold: string;
  period_index: number;
  spent: string;
  reserved: string;
}
export interface TokenView {
  token: string;
  symbol: string;
  decimals: number;
  balance: string;
  pending_approval: string;
  in_flight: string;
  available: string;
  shared_cap: string;
  shared_spent: string;
  shared_reserved: string;
}
/** How to show an amount: NEAR or a token. */
export interface Asset {
  token: string | null;
  symbol: string;
  decimals: number;
}
export const NEAR_ASSET: Asset = { token: null, symbol: 'NEAR', decimals: 24 };
export interface Balances {
  vault_balance: string;
  operating_reserve: string;
  storage_cost: string;
  pending_approval: string;
  in_flight: string;
  available: string;
  shared_spent: string;
  shared_reserved: string;
  shared_cap: string;
}
export interface Config {
  owner: string;
  paused: boolean;
  period_ms: number;
  shared_cap: string;
  current_period: number;
  recipient_cooldown_ms: number;
  max_payments_per_hour: number;
  owner_encryption_key: string | null;
  encrypted_memos_only: boolean;
  require_tee: boolean;
  pending_owner: string | null;
  approval_ttl_ms: number;
  history_limit: number;
  in_flight_recovery_ms: number;
  open_payments: number;
  require_origin: boolean;
}
export interface HiddenRecipient {
  fingerprint: string;
  added_at_ms: number;
  payable_from_ms: number;
  label: string | null;
}
export interface TeeMeasurement {
  mrtd: string;
  rtmr0: string;
  rtmr1: string;
  rtmr2: string;
  compose_hash: string;
  key_provider_digest: string | null;
}
export interface TeePolicy {
  require_tee: boolean;
  attestation_ttl_ms: number;
  allow_sw_hardening_needed: boolean;
  measurements: [string, TeeMeasurement][];
  ppids: string[];
}
export interface TeeInfo {
  measurement_id: string;
  compose_hash: string;
  ppid: string;
  tcb_status: string;
  attested_at_ms: number;
  valid_until_ms: number;
}
export interface Recipient {
  account: string;
  added_at_ms: number;
  payable_from_ms: number;
}
export interface RateWindow {
  window_start_ms: number;
  count: number;
}
export interface VaultState {
  config: Config;
  balances: Balances;
  agents: [string, Agent][];
  allowlist: string[];
  requests: PaymentRequest[];
  blocked: BlockedAttempt[];
  blockedCount: number;
  tokens: TokenView[];
  /** agent → [token, limits][] */
  tokenLimits: Record<string, [string, Limits][]>;
  recipients: Recipient[];
  /** agent → payments in the current one-hour window */
  rates: Record<string, RateWindow>;
  hidden: HiddenRecipient[];
  tee: TeePolicy;
  /** agent → its accepted attestation */
  agentTee: Record<string, TeeInfo>;
  tasks: Task[];
  /** Agents whose origin labels the owner vouches for without a TEE. */
  vouched: string[];
}

export function assetOf(state: Pick<VaultState, 'tokens'>, token: string | null | undefined): Asset {
  if (!token) return NEAR_ASSET;
  const t = state.tokens.find((x) => x.token === token);
  return t ? { token, symbol: t.symbol, decimals: t.decimals } : { token, symbol: token, decimals: 0 };
}

// ------------------------------------------------------------------- reads

let rpcId = 0;
// At most 4 requests in flight: free public nodes refuse bursts.
let inFlight = 0;
const waiting: (() => void)[] = [];
async function slot<T>(f: () => Promise<T>): Promise<T> {
  if (inFlight >= 4) await new Promise<void>((r) => waiting.push(r));
  inFlight += 1;
  try { return await f(); } finally { inFlight -= 1; waiting.shift()?.(); }
}

async function rpcPost(url: string, method: string, params: unknown) {
  return slot(() => rpcPostNow(url, method, params));
}
async function rpcPostNow(url: string, method: string, params: unknown) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  });
  if (!res.ok) throw new Error(`RPC ${url} answered ${res.status}`);
  return res.json();
}

async function rpc<T>(nodeUrl: string, method: string, params: unknown): Promise<T> {
  const first = working.get(nodeUrl) ?? nodeUrl;
  const urls = [first, ...[nodeUrl, ...(FALLBACKS[nodeUrl] ?? [])].filter((u) => u !== first)];
  let body: { error?: { data?: string; message?: string }; result?: { error?: string } } | undefined;
  let lastErr: unknown;
  for (const url of urls) {
    try {
      body = await rpcPost(url, method, params);
      working.set(nodeUrl, url);
      break;
    } catch (e) {
      lastErr = e; // unreachable, blocked or rate-limited: try the next node
    }
  }
  if (!body) throw new Error(`Couldn’t reach a NEAR RPC node (${lastErr instanceof Error ? lastErr.message : String(lastErr)})`);
  if (body.error) throw new Error(body.error.data ?? body.error.message ?? 'RPC error');
  if (body.result?.error) throw new Error(body.result.error);
  return body.result as T;
}

const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));

export async function view<T>(nodeUrl: string, contractId: string, method: string, args: object = {}): Promise<T> {
  const r = await rpc<{ result: number[] }>(nodeUrl, 'query', {
    request_type: 'call_function',
    finality: 'optimistic',
    account_id: contractId,
    method_name: method,
    args_base64: b64(JSON.stringify(args)),
  });
  return JSON.parse(new TextDecoder().decode(new Uint8Array(r.result))) as T;
}

export async function loadVault(nodeUrl: string, contractId: string): Promise<VaultState> {
  const v = <T,>(m: string, a: object = {}) => view<T>(nodeUrl, contractId, m, a);
  const [config, balances, agents, allowlist, recent, open, blocked, blockedCount, tokens, recipients, hidden, tee, teeList, tasks, vouched] = await Promise.all([
    v<Config>('get_config'),
    v<Balances>('get_balances'),
    v<[string, Agent][]>('list_agents'),
    v<string[]>('list_allowlist'),
    v<PaymentRequest[]>('list_requests', { limit: 100 }),
    // Open payments are always shown, even once they're older than the last 100.
    v<PaymentRequest[]>('list_open'),
    v<BlockedAttempt[]>('list_blocked'),
    v<number>('blocked_count'),
    v<TokenView[]>('list_tokens'),
    v<Recipient[]>('list_recipients'),
    v<HiddenRecipient[]>('list_hidden_recipients'),
    v<TeePolicy>('get_tee_policy'),
    v<[string, TeeInfo][]>('list_agent_tee'),
    v<Task[]>('list_tasks'),
    v<string[]>('list_vouched'),
  ]);
  const agentTee: Record<string, TeeInfo> = Object.fromEntries(teeList);
  const seen = new Set(recent.map((r) => r.key));
  const requests = [...recent, ...open.filter((r) => !seen.has(r.key))];
  const rateList = await Promise.all(agents.map(([id]) => v<RateWindow>('get_agent_rate', { agent: id })));
  const rates: Record<string, RateWindow> = {};
  agents.forEach(([id], i) => (rates[id] = rateList[i]));
  const tokenLimits: Record<string, [string, Limits][]> = {};
  if (tokens.length) {
    const lists = await Promise.all(agents.map(([id]) => v<[string, Limits][]>('get_agent_token_limits', { agent: id })));
    agents.forEach(([id], i) => (tokenLimits[id] = lists[i]));
  }
  return { config, balances, agents, allowlist, requests, blocked, blockedCount, tokens, tokenLimits, recipients, rates, hidden, tee, agentTee, tasks, vouched };
}

// ------------------------------------------------------------------ writes

export interface Call { method: string; args: object }
export interface Writer {
  accountId: string | null;
  call(method: string, args: object, depositYocto?: string): Promise<string | undefined>;
  /** Several calls on the vault, in one transaction where the signer allows it (all or nothing). */
  calls(list: Call[]): Promise<string | undefined>;
}

export interface SandboxConfig {
  network: 'sandbox';
  nodeUrl: string;
  contractId: string;
  owner: string;
  agents: string[];
  vendor: string;
  attacker: string;
  usdc: string | null;
  llmAgent: boolean;
  /** Published demo passphrase for private mode on the sandbox. */
  demoPassphrase?: string;
}

export async function sandboxConfig(): Promise<SandboxConfig> {
  const r = await fetch(`${SANDBOX_API}/config`);
  if (!r.ok) throw new Error('sandbox API not reachable');
  return r.json();
}

async function post<T>(path: string, body?: object): Promise<T> {
  const r = await fetch(`${SANDBOX_API}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(prettyError(j.error ?? r.statusText));
  return j as T;
}

export function sandboxWriter(cfg: SandboxConfig): Writer {
  return {
    accountId: cfg.owner,
    call: async (method, args, deposit) => (await post<{ hash: string }>('/call', { method, args, deposit })).hash,
    calls: async (list) => {
      let hash: string | undefined;
      for (const c of list) hash = (await post<{ hash: string }>('/call', { method: c.method, args: c.args })).hash;
      return hash;
    },
  };
}

export const runScenario = (name: string) => post<unknown>(`/scenario/${name}`);

/** Pull the human-readable panic out of a NEAR execution error. */
export function prettyError(e: unknown): string {
  const s = typeof e === 'string' ? e : (e as Error)?.message ?? JSON.stringify(e);
  const m = s.match(/Smart contract panicked: ([^"\\]+)/);
  return m ? m[1] : s.slice(0, 200);
}

export interface WalletHandle {
  selector: WalletSelector;
  modal: WalletSelectorModal;
}

const walletCache = new Map<string, Promise<WalletHandle>>();

export function wallet(network: 'testnet' | 'mainnet', contractId: string): Promise<WalletHandle> {
  const k = `${network}:${contractId}`;
  if (!walletCache.has(k)) {
    walletCache.set(k, (async () => {
      // Loaded on demand so the sandbox view never pulls in wallet code.
      const [{ Buffer }, { setupWalletSelector }, { setupModal }, mnw, meteor, here, intear] = await Promise.all([
        import('buffer'),
        import('@near-wallet-selector/core'),
        import('@near-wallet-selector/modal-ui'),
        import('@near-wallet-selector/my-near-wallet'),
        import('@near-wallet-selector/meteor-wallet'),
        import('@near-wallet-selector/here-wallet'),
        import('@near-wallet-selector/intear-wallet'),
      ]);
      const g = globalThis as { Buffer?: unknown };
      g.Buffer ??= Buffer;
      const { setupMyNearWallet } = mnw, { setupMeteorWallet } = meteor, { setupHereWallet } = here, { setupIntearWallet } = intear;
      const selector = await setupWalletSelector({
        network,
        modules: [setupMeteorWallet(), setupMyNearWallet(), setupHereWallet(), setupIntearWallet()],
      });
      const modal = setupModal(selector, { contractId });
      return { selector, modal };
    })());
  }
  return walletCache.get(k)!;
}

/**
 * Ask the wallet to sign the private-mode unlock message (NEP-413). Returns
 * the signature bytes, or throws if this wallet can't sign messages here.
 */
export async function signUnlock(h: WalletHandle, message: string, recipient: string, nonce: Uint8Array): Promise<Uint8Array> {
  const w = await h.selector.wallet();
  if (!('signMessage' in w) || typeof w.signMessage !== 'function') throw new Error('This wallet can’t sign messages. Use a passphrase instead.');
  const { Buffer } = await import('buffer');
  const out = await w.signMessage({ message, recipient, nonce: Buffer.from(nonce) });
  if (!out?.signature) throw new Error('The wallet didn’t return a signature. Wallets that redirect can’t unlock here; use a passphrase instead.');
  return Uint8Array.from(atob(out.signature), (c) => c.charCodeAt(0));
}

export function walletWriter(h: WalletHandle, contractId: string): Writer {
  const accounts = h.selector.store.getState().accounts;
  const accountId = accounts.find((a) => a.active)?.accountId ?? accounts[0]?.accountId ?? null;
  const send = async (actions: ReturnType<typeof actionCreators.functionCall>[]) => {
    const w = await h.selector.wallet();
    const out = await w.signAndSendTransaction({ receiverId: contractId, actions });
    if (!out) return undefined;
    const status = out.status as { Failure?: unknown };
    if (status && typeof status === 'object' && 'Failure' in status) throw new Error(prettyError(JSON.stringify(status.Failure)));
    return out.transaction?.hash;
  };
  return {
    accountId,
    call: (method, args, deposit = '0') => send([actionCreators.functionCall(method, args, 150_000_000_000_000n, BigInt(deposit))]),
    calls: (list) => send(list.map((c) => actionCreators.functionCall(c.method, c.args, BigInt(Math.floor(150_000_000_000_000 / list.length)), 0n))),
  };
}

export interface FactoryInfo { owner: string; vault_code_hash: string | null; vaults_created: number; min_deposit: string }

/**
 * Create a vault through the factory, signed by the connected wallet. Resolves
 * to the new vault's account id once the chain confirms it; throws with the
 * reason otherwise (the factory refunds the deposit when creation fails).
 */
export async function createVault(h: WalletHandle, factory: string, name: string, depositYocto: string, periodMs: number, sharedCapYocto: string): Promise<string> {
  const w = await h.selector.wallet();
  const out = await w.signAndSendTransaction({
    receiverId: factory,
    actions: [actionCreators.functionCall('create_vault', { name, period_ms: periodMs, shared_cap: sharedCapYocto }, 300_000_000_000_000n, BigInt(depositYocto))],
  });
  if (!out) throw new Error('The wallet didn’t return a result. Check your wallet’s activity, then reload.');
  const status = out.status as { Failure?: unknown; SuccessValue?: string };
  if (status && typeof status === 'object' && 'Failure' in status) throw new Error(prettyError(JSON.stringify(status.Failure)));
  const value = status && typeof status === 'object' && typeof status.SuccessValue === 'string' ? atob(status.SuccessValue) : '';
  const vault = value ? (JSON.parse(value) as string | null) : null;
  if (!vault) throw new Error(`“${name}.${factory}” couldn’t be created (the name may be taken). Your deposit was refunded.`);
  return vault;
}

/**
 * Create the agent's own account as `<name>.<owner>` holding only the given
 * public key, restricted to calling request_payment on the vault, then
 * register it on the vault with its limits. Two wallet-signed transactions.
 * The private key never reaches the browser: the agent's machine made it
 * (`banbo-mcp keygen`) and only the public key is pasted here.
 */
export async function connectAgent(h: WalletHandle, o: {
  owner: string; vault: string; agent: string; publicKey: string; fundYocto: string; allowanceYocto: string;
  perTxMax: string; periodLimit: string; approvalThreshold: string;
}): Promise<void> {
  const w = await h.selector.wallet();
  const { PublicKey } = await import('@near-js/crypto');
  const pk = PublicKey.fromString(o.publicKey);
  const outs = await w.signAndSendTransactions({
    transactions: [
      {
        signerId: o.owner,
        receiverId: o.agent,
        actions: [
          actionCreators.createAccount(),
          actionCreators.transfer(BigInt(o.fundYocto)),
          actionCreators.addKey(pk, actionCreators.functionCallAccessKey(o.vault, ['request_payment'], BigInt(o.allowanceYocto))),
        ],
      },
      {
        signerId: o.owner,
        receiverId: o.vault,
        actions: [actionCreators.functionCall('add_agent', {
          agent: o.agent, per_tx_max: o.perTxMax, period_limit: o.periodLimit, approval_threshold: o.approvalThreshold,
        }, 50_000_000_000_000n, 0n)],
      },
    ],
  });
  for (const out of outs ?? []) {
    const status = out.status as { Failure?: unknown };
    if (status && typeof status === 'object' && 'Failure' in status) throw new Error(prettyError(JSON.stringify(status.Failure)));
  }
}
