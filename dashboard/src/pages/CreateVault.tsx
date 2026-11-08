import { useEffect, useState, type FormEvent } from 'react';
import { useBanbo } from '../state';
import { FACTORY, NETWORKS, createVault, view, wallet, prettyError, type FactoryInfo, type WalletHandle } from '../near';
import { Panel, PageHeader, Empty } from '../ui';
import { near, short, toYocto } from '../format';

// One or two words, letters and digits only. The words are joined and
// lowercased for the account name: "Nectar Beauty" -> nectarbeauty.
const WORDS = /^[a-z\d]+( [a-z\d]+)?$/i;
const toAccountName = (v: string) => v.trim().replace(/\s+/g, ' ').toLowerCase().replace(/ /g, '');
const DAY_MS = 86_400_000;

/** Create a vault from the browser: one wallet-signed transaction to the factory. */
export default function CreateVault() {
  const b = useBanbo();
  const factory = FACTORY[b.network];
  const [h, setH] = useState<WalletHandle | null>(null);
  const [account, setAccount] = useState<string | null>(null);
  const [info, setInfo] = useState<FactoryInfo | null>(null);
  const [f, setF] = useState({ name: '', deposit: '9', cap: '1' });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!factory) return;
    let unsub: (() => void) | undefined;
    wallet(b.network as 'testnet' | 'mainnet', factory).then((w) => {
      setH(w);
      const pick = () => {
        const acc = w.selector.store.getState().accounts;
        setAccount(acc.find((a) => a.active)?.accountId ?? acc[0]?.accountId ?? null);
      };
      pick();
      const sub = w.selector.store.observable.subscribe(pick);
      unsub = () => sub.unsubscribe();
    }).catch((e) => setErr(`Wallet: ${prettyError(e)}`));
    view<FactoryInfo>(NETWORKS[b.network].nodeUrl, factory, 'get_info').then(setInfo).catch((e) => setErr(`Couldn’t read the factory ${factory}: ${prettyError(e)}`));
    return () => unsub?.();
  }, [b.network, factory]);

  if (!factory) {
    return (
      <>
        <PageHeader title="Create a vault" />
        <Empty title={b.network === 'sandbox' ? 'The local sandbox already has a vault' : 'Not available on this network yet'}>
          <p className="muted">{b.network === 'sandbox' ? 'It is created when the sandbox starts.' : 'Vault creation from the browser is on NEAR Testnet for now.'}</p>
        </Empty>
      </>
    );
  }

  // min_deposit = code storage + 1 NEAR of working balance (see contract/factory).
  const codeStorage = info ? (BigInt(info.min_deposit) - 10n ** 24n).toString() : '0';
  const name = toAccountName(f.name);
  const vaultId = name ? `${name}.${factory}` : `yourname.${factory}`;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      if (!h) throw new Error('The wallet isn’t ready yet.');
      if (!account) { h.modal.show(); return; }
      if (!WORDS.test(f.name.trim().replace(/\s+/g, ' ')) || name.length < 2 || name.length > 32) throw new Error('Name: one or two words, letters and digits only (2–32 characters).');
      const deposit = toYocto(f.deposit);
      if (info && !info.vault_code_hash) throw new Error('Vault creation isn’t open yet on this network.');
      if (info && BigInt(deposit) < BigInt(info.min_deposit)) throw new Error(`Start with at least ${near(info.min_deposit)} NEAR: about ${near(codeStorage)} NEAR stays locked to store the vault’s code, and the rest is its working balance.`);
      const cap = toYocto(f.cap);
      if (BigInt(cap) === 0n) throw new Error('Set a daily limit above 0.');
      setErr(''); setBusy(true);
      const id = await createVault(h, factory, name, deposit, DAY_MS, cap);
      b.setContract(id);
      b.toast('ok', `Vault ${id} created`);
      window.location.hash = '#/overview';
    } catch (x) {
      setErr(prettyError(x));
    } finally {
      setBusy(false);
    }
  };
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  return (
    <>
      <PageHeader title="Create a vault" subtitle="One transaction from your wallet. You own the vault; nobody else can change its rules or its code." />
      <Panel title="New vault">
        <form className="form" onSubmit={submit}>
          <label className="field">
            <span>Vault name</span>
            <input value={f.name} onChange={set('name')} placeholder="Acme Treasury" spellCheck={false} autoComplete="off" />
            <small>Your vault will be <span className="mono">{vaultId}</span></small>
          </label>
          <div className="form-row two">
            <label className="field">
              <span>Starting balance (NEAR)</span>
              <input value={f.deposit} onChange={set('deposit')} inputMode="decimal" />
              <small>Moves from your wallet into the vault.{info ? <> About {near(codeStorage)} NEAR stays locked to store the vault’s code, and 0.5 NEAR stays back for gas.</> : null}</small>
            </label>
            <label className="field">
              <span>Daily limit for all agents (NEAR)</span>
              <input value={f.cap} onChange={set('cap')} inputMode="decimal" />
              <small>The most all your agents together can spend in a day. You can change it later.</small>
            </label>
          </div>
          {err && <p className="form-err" role="alert">{err}</p>}
          <div className="form-actions">
            <button className="btn primary" disabled={busy || !h}>
              {busy ? 'Waiting for confirmation…' : account ? `Create vault as ${b.nameFor(account) ?? short(account)}` : 'Connect wallet to continue'}
            </button>
          </div>
          <p className="muted xs">
            Every vault runs a copy of the published Banbo contract, with the code hash
            {info?.vault_code_hash ? <> <span className="mono">{info.vault_code_hash}</span></> : null}. A vault has no access keys, so nobody, including the factory, can change its code later.
            If creation fails, your deposit comes back.
          </p>
        </form>
      </Panel>
    </>
  );
}
