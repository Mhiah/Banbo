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
  memo: string;
  status: Status;
  period_index: number;
  created_at_ms: number;
}
export interface BlockedAttempt {
  agent: string;
  request_id: string;
  recipient: string;
  amount: string;
  reason: string;
  memo: string;
  at_ms: number;
}
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
}
export interface VaultState {
  config: Config;
  balances: Balances;
  agents: [string, Agent][];
  allowlist: string[];
  requests: PaymentRequest[];
  blocked: BlockedAttempt[];
  blockedCount: number;
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
  const [config, balances, agents, allowlist, requests, blocked, blockedCount] = await Promise.all([
    v<Config>('get_config'),
    v<Balances>('get_balances'),
    v<[string, Agent][]>('list_agents'),
    v<string[]>('list_allowlist'),
    v<PaymentRequest[]>('list_requests', { limit: 100 }),
    v<BlockedAttempt[]>('list_blocked'),
    v<number>('blocked_count'),
  ]);
  return { config, balances, agents, allowlist, requests, blocked, blockedCount };
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
  llmAgent: boolean;
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

export function walletWriter(h: WalletHandle, contractId: string): Writer {
  const accounts = h.selector.store.getState().accounts;
  const accountId = accounts.find((a) => a.active)?.accountId ?? accounts[0]?.accountId ?? null;
  return {
    accountId,
    call: async (method, args, deposit = '0') => {
      const w = await h.selector.wallet();
      const out = await w.signAndSendTransaction({
        receiverId: contractId,
        actions: [actionCreators.functionCall(method, args, 100_000_000_000_000n, BigInt(deposit))],
      });
      if (!out) return undefined;
      const status = out.status as { Failure?: unknown };
      if (status && typeof status === 'object' && 'Failure' in status) throw new Error(prettyError(JSON.stringify(status.Failure)));
      return out.transaction?.hash;
    },
  };
}
