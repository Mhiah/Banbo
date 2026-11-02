import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  NETWORKS, NETWORK_IDS, FACTORY, type NetworkId, type VaultState, type Writer, type SandboxConfig, type WalletHandle,
  loadVault, view, sandboxConfig, sandboxWriter, wallet, walletWriter, prettyError, signUnlock,
} from './near';
import { keyPairFromPassphrase, keyPairFromSignature, unlockMessage, unlockNonce, type OwnerKeys } from './privacy';

export type Toast = { id: number; kind: 'ok' | 'err'; text: string };

const ls = {
  get: (k: string, d = '') => localStorage.getItem(`banbo:${k}`) ?? d,
  set: (k: string, v: string) => localStorage.setItem(`banbo:${k}`, v),
};

/** A pasted account id: no surrounding spaces, no trailing full stop. */
export const cleanAccountId = (v: string) => v.trim().replace(/\.+$/, '');

/** The network to open on: the last one used, if this build offers it. */
function startNetwork(): NetworkId {
  const saved = ls.get('network') as NetworkId;
  return NETWORK_IDS.includes(saved) ? saved : NETWORK_IDS[0];
}
/** The vault this account last opened on a network. Nothing is shown before a wallet connects. */
function savedContract(n: NetworkId, account: string | null | undefined): string {
  return account ? ls.get(`contract:${n}:${account}`) : '';
}
/** A vault named in the link (#/overview?vault=...), opened for viewing. */
function linkedVault(): string {
  return cleanAccountId(new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('vault') ?? '');
}

/** Where this account's vault would be: the deploy script's vault.<account>, or <name>.<factory>. */
function vaultCandidates(n: NetworkId, account: string): string[] {
  const out = [`vault.${account}`];
  const f = FACTORY[n];
  const base = account.split('.')[0];
  if (f && base) out.push(`${base}.${f}`);
  return out;
}
/** The first candidate vault this account owns, or '' if none. */
async function findOwnVault(n: NetworkId, account: string): Promise<string> {
  for (const id of vaultCandidates(n, account)) {
    try {
      const cfg = await view<{ owner: string }>(NETWORKS[n].nodeUrl, id, 'get_config');
      if (cfg.owner === account) return id;
    } catch { /* no such vault */ }
  }
  return '';
}

function useBanboState() {
  const [network, setNetworkRaw] = useState<NetworkId>(startNetwork);
  const [contractInput, setContractInput] = useState(linkedVault);
  const [sandbox, setSandbox] = useState<SandboxConfig | null>(null);
  const [sandboxDown, setSandboxDown] = useState(false);
  const [handle, setHandle] = useState<WalletHandle | null>(null);
  const [writer, setWriter] = useState<Writer | null>(null);
  const [state, setState] = useState<VaultState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  // Private-mode key: memory only, gone on reload or vault switch.
  const [keys, setKeys] = useState<OwnerKeys | null>(null);
  // Looking up the connected account's vault.
  const [finding, setFinding] = useState(false);

  const nodeUrl = network === 'sandbox' ? sandbox?.nodeUrl ?? '' : NETWORKS[network].nodeUrl;
  const contractId = network === 'sandbox' ? sandbox?.contractId ?? '' : cleanAccountId(contractInput);
  const explorer = NETWORKS[network].explorer;

  const toast = useCallback((kind: Toast['kind'], text: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, kind, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'err' ? 8000 : 4000);
  }, []);

  const setNetwork = (n: NetworkId) => {
    ls.set('network', n);
    setContractInput(savedContract(n, writer?.accountId));
    setNetworkRaw(n);
  };
  const setContract = (v: string) => {
    setContractInput(v);
    if (writer?.accountId) ls.set(`contract:${network}:${writer.accountId}`, cleanAccountId(v));
  };

  // A link that names a vault opens it.
  useEffect(() => {
    const on = () => { const v = linkedVault(); if (v) setContractInput(v); };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  // Connecting a wallet opens that account's vault; signing out closes it.
  const account = network === 'sandbox' ? null : writer?.accountId ?? null;
  const firstAccount = useRef(true);
  useEffect(() => {
    if (network === 'sandbox') return;
    if (firstAccount.current) { firstAccount.current = false; if (linkedVault() && !account) return; }
    const known = linkedVault() || savedContract(network, account);
    setContractInput(known);
    if (known || !account) { setFinding(false); return; }
    let live = true;
    setFinding(true);
    findOwnVault(network, account).then((id) => {
      if (!live) return;
      setFinding(false);
      if (id) { setContractInput(id); ls.set(`contract:${network}:${account}`, id); }
    });
    return () => { live = false; };
  }, [account, network]);

  useEffect(() => setKeys(null), [network, contractId]);

  /** Derive the private-mode key. Returns it, or null after showing why not. */
  const deriveWithWallet = useCallback(async (): Promise<OwnerKeys | null> => {
    if (!handle || !contractId) return null;
    try {
      const { message, recipient } = unlockMessage(contractId);
      const sig = await signUnlock(handle, message, recipient, await unlockNonce(contractId));
      return await keyPairFromSignature(sig);
    } catch (e) {
      toast('err', prettyError(e));
      return null;
    }
  }, [handle, contractId, toast]);
  const deriveWithPassphrase = useCallback(
    (passphrase: string) => keyPairFromPassphrase(passphrase, contractId),
    [contractId],
  );

  // network switch
  useEffect(() => {
    setState(null); setLoadError(null); setWriter(null); setHandle(null); setSandboxDown(false);
    if (network !== 'sandbox') return;
    let stop = false;
    const connect = () => sandboxConfig()
      .then((cfg) => { if (!stop) { setSandbox(cfg); setWriter(sandboxWriter(cfg)); setSandboxDown(false); } })
      .catch(() => { if (!stop) { setSandbox(null); setSandboxDown(true); setTimeout(connect, 3000); } });
    connect();
    return () => { stop = true; };
  }, [network]);

  // wallet: available before any vault is chosen, so a visitor can connect first.
  const walletContract = network === 'sandbox' ? '' : FACTORY[network] ?? contractId;
  useEffect(() => {
    if (network === 'sandbox' || !walletContract) return;
    let unsub: (() => void) | undefined;
    wallet(network, walletContract).then((h) => {
      setHandle(h);
      setWriter(walletWriter(h, contractId));
      const sub = h.selector.store.observable.subscribe(() => setWriter(walletWriter(h, contractId)));
      unsub = () => sub.unsubscribe();
    }).catch((e) => toast('err', `Wallet: ${prettyError(e)}`));
    return () => unsub?.();
  }, [network, walletContract, contractId, toast]);

  // Public RPC nodes rate-limit, so testnet/mainnet are read less often, one
  // read at a time, and a single failed read doesn't replace a vault already
  // on screen with an error.
  const reading = useRef<Promise<void> | null>(null);
  const failures = useRef(0);
  const loaded = useRef(false);
  const shown = useRef(contractId);
  shown.current = contractId;
  /** Read the vault. A poll skips if a read is running; after a change (`fresh`), wait for it and read again. */
  const refresh = useCallback(async (fresh = false) => {
    if (!nodeUrl || !contractId) return;
    if (reading.current) {
      if (!fresh) return;
      await reading.current;
    }
    const run = (async () => {
      try {
        const next = await loadVault(nodeUrl, contractId);
        if (shown.current !== contractId) return; // the visitor switched vaults meanwhile
        setState(next);
        setLoadError(null);
        failures.current = 0;
        loaded.current = true;
      } catch (e) {
        if (shown.current !== contractId) return;
        failures.current += 1;
        // Public nodes refuse bursts now and then: retry quietly before showing an error.
        if (network === 'sandbox' || failures.current >= 3) setLoadError(prettyError(e));
        else if (!loaded.current) setTimeout(() => refresh(), 3000 * failures.current);
        if (network === 'sandbox') { setSandboxDown(true); setSandbox(null); }
      }
    })();
    reading.current = run;
    try { await run; } finally { if (reading.current === run) reading.current = null; }
  }, [nodeUrl, contractId, network]);

  useEffect(() => {
    failures.current = 0;
    loaded.current = false;
    refresh();
    // Testnet and mainnet use free public nodes: read every 15 s, and not while the tab is hidden.
    const t = setInterval(() => { setNow(Date.now()); if (network === 'sandbox' || !document.hidden) refresh(); }, network === 'sandbox' ? 2000 : 15000);
    const onShow = () => { if (!document.hidden) refresh(); };
    document.addEventListener('visibilitychange', onShow);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', onShow); };
  }, [refresh, network]);

  const isOwner = !!state && !!writer?.accountId && writer.accountId === state.config.owner;

  /** Sign and send an owner action. Resolves true once confirmed. */
  const act = useCallback(async (label: string, method: string, args: object = {}, deposit?: string): Promise<boolean> => {
    if (!writer) return false;
    setBusy(label);
    try {
      await writer.call(method, args, deposit);
      await refresh(true);
      toast('ok', label);
      return true;
    } catch (e) {
      toast('err', prettyError(e));
      return false;
    } finally {
      setBusy(null);
    }
  }, [writer, refresh, toast]);

  return {
    network, setNetwork, contractInput, setContract, contractId, nodeUrl, explorer, finding,
    sandbox, sandboxDown, handle, writer, state, loadError, toasts, toast, busy, setBusy, now,
    isOwner, refresh, act,
    keys, setKeys, deriveWithWallet, deriveWithPassphrase,
  };
}

export type Banbo = ReturnType<typeof useBanboState>;
const Ctx = createContext<Banbo | null>(null);

export function BanboProvider({ children }: { children: ReactNode }) {
  const v = useBanboState();
  return <Ctx.Provider value={v}>{children}</Ctx.Provider>;
}

export function useBanbo(): Banbo {
  const v = useContext(Ctx);
  if (!v) throw new Error('useBanbo outside provider');
  return v;
}
