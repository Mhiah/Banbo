// Talking to the Banbo contract: read via JSON-RPC, write via the wallet
// (testnet/mainnet) or via the local sandbox API (keys stay in that process).
import type { WalletSelector } from '@near-wallet-selector/core';
import type { WalletSelectorModal } from '@near-wallet-selector/modal-ui';
import { actionCreators } from '@near-js/transactions';

export type NetworkId = 'sandbox' | 'testnet' | 'mainnet';

export const NETWORKS: Record<NetworkId, { label: string; nodeUrl: string; explorer?: string }> = {
  sandbox: { label: 'Local sandbox', nodeUrl: '' },
  testnet: { label: 'Testnet', nodeUrl: 'https://rpc.testnet.near.org', explorer: 'https://testnet.nearblocks.io' },
  mainnet: { label: 'Mainnet', nodeUrl: 'https://rpc.mainnet.near.org', explorer: 'https://nearblocks.io' },
};

export const SANDBOX_API = import.meta.env.VITE_SANDBOX_API ?? 'http://localhost:3031';

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
export type Status = 'PendingApproval' | 'InFlight' | 'Settled' | 'Failed' | 'Declined';
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
}

export function assetOf(state: Pick<VaultState, 'tokens'>, token: string | null | undefined): Asset {
  if (!token) return NEAR_ASSET;
  const t = state.tokens.find((x) => x.token === token);
  return t ? { token, symbol: t.symbol, decimals: t.decimals } : { token, symbol: token, decimals: 0 };
}

// ------------------------------------------------------------------- reads

let rpcId = 0;
async function rpc<T>(nodeUrl: string, method: string, params: unknown): Promise<T> {
  const res = await fetch(nodeUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  });
  const body = await res.json();
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
  const [config, balances, agents, allowlist, requests, blocked, blockedCount, tokens, recipients, hidden, tee, teeList] = await Promise.all([
    v<Config>('get_config'),
    v<Balances>('get_balances'),
    v<[string, Agent][]>('list_agents'),
    v<string[]>('list_allowlist'),
    v<PaymentRequest[]>('list_requests', { limit: 100 }),
    v<BlockedAttempt[]>('list_blocked'),
    v<number>('blocked_count'),
    v<TokenView[]>('list_tokens'),
    v<Recipient[]>('list_recipients'),
    v<HiddenRecipient[]>('list_hidden_recipients'),
    v<TeePolicy>('get_tee_policy'),
    v<[string, TeeInfo][]>('list_agent_tee'),
  ]);
  const agentTee: Record<string, TeeInfo> = Object.fromEntries(teeList);
  const rateList = await Promise.all(agents.map(([id]) => v<RateWindow>('get_agent_rate', { agent: id })));
  const rates: Record<string, RateWindow> = {};
  agents.forEach(([id], i) => (rates[id] = rateList[i]));
  const tokenLimits: Record<string, [string, Limits][]> = {};
  if (tokens.length) {
    const lists = await Promise.all(agents.map(([id]) => v<[string, Limits][]>('get_agent_token_limits', { agent: id })));
    agents.forEach(([id], i) => (tokenLimits[id] = lists[i]));
  }
  return { config, balances, agents, allowlist, requests, blocked, blockedCount, tokens, tokenLimits, recipients, rates, hidden, tee, agentTee };
}

// ------------------------------------------------------------------ writes

export interface Writer {
  accountId: string | null;
  call(method: string, args: object, depositYocto?: string): Promise<string | undefined>;
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
  return {
    accountId,
    call: async (method, args, deposit = '0') => {
      const w = await h.selector.wallet();
      const out = await w.signAndSendTransaction({
        receiverId: contractId,
        actions: [actionCreators.functionCall(method, args, 150_000_000_000_000n, BigInt(deposit))],
      });
      if (!out) return undefined;
      const status = out.status as { Failure?: unknown };
      if (status && typeof status === 'object' && 'Failure' in status) throw new Error(prettyError(JSON.stringify(status.Failure)));
      return out.transaction?.hash;
    },
  };
}
