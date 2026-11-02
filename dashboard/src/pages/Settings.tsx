import { useState } from 'react';
import { useBanbo } from '../state';
import { NETWORKS, NETWORK_IDS, SANDBOX_API } from '../near';
import { Panel, PageHeader, Addr, Dialog, ChangeSummary } from '../ui';
import { short } from '../format';

const ACCOUNT_RE = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

export default function Settings() {
  const b = useBanbo();
  return (
    <>
      <PageHeader title="Settings" subtitle="Choose the network and vault this dashboard manages." />
      <Panel title="Network">
        <div className="radio-list" role="radiogroup" aria-label="Network">
          {NETWORK_IDS.map((n) => (
            <label key={n} className={`radio ${b.network === n ? 'on' : ''}`}>
              <input type="radio" name="network" checked={b.network === n} onChange={() => b.setNetwork(n)} />
              <span className="radio-title">{n === 'sandbox' ? 'Local sandbox' : `NEAR ${NETWORKS[n].label}`}</span>
              <span className="radio-desc">
                {n === 'sandbox' && 'A NEAR node on this machine with a seeded vault and test agents. For development and the demo.'}
                {n === 'testnet' && 'Test NEAR with no real value. Connect a testnet wallet.'}
                {n === 'mainnet' && 'Real funds. Connect the wallet that owns your vault.'}
              </span>
            </label>
          ))}
        </div>
      </Panel>

      <Panel title="Vault">
        {b.network === 'sandbox' ? (
          <dl className="kv left">
            <dt>Contract</dt><dd className="mono">{b.sandbox?.contractId ?? 'Sandbox not running'}</dd>
            <dt>Owner</dt><dd className="mono">{b.sandbox?.owner ?? '-'}</dd>
            <dt>Node</dt><dd className="mono">{b.sandbox?.nodeUrl ?? '-'}</dd>
            <dt>Sandbox API</dt><dd className="mono">{SANDBOX_API}</dd>
          </dl>
        ) : (
          <form className="form" onSubmit={(e) => e.preventDefault()}>
            <label className="field">
              <span>Vault contract account</span>
              <input value={b.contractInput} onChange={(e) => b.setContract(e.target.value)} placeholder={b.network === 'mainnet' ? 'vault.yourname.near' : 'vault.yourname.testnet'} spellCheck={false} />
              <small>The account the Banbo contract is deployed to.</small>
            </label>
            {b.state && <p className="ok-text small">Connected. Owner: <Addr id={b.state.config.owner} explorer={b.explorer} full /></p>}
            {b.loadError && b.contractId && <p className="form-err">{b.loadError}</p>}
          </form>
        )}
      </Panel>

      {b.state && <Ownership />}

      {b.network !== 'sandbox' && (
        <Panel title="Wallet">
          {b.writer?.accountId ? (
            <dl className="kv left">
              <dt>Connected</dt><dd className="mono">{b.writer.accountId}</dd>
              <dt>Role</dt><dd>{b.state ? (b.isOwner ? 'Vault owner: can change rules and approve payments' : 'Viewer: read-only') : '-'}</dd>
            </dl>
          ) : b.handle ? <button className="btn primary" onClick={() => b.handle!.modal.show()}>Connect wallet</button> : <p className="muted">Enter a vault first.</p>}
        </Panel>
      )}
    </>
  );
}

/** Two-step ownership transfer: the owner proposes, the new owner accepts. */
function Ownership() {
  const b = useBanbo();
  const c = b.state!.config;
  const [to, setTo] = useState('');
  const [err, setErr] = useState('');
  const [review, setReview] = useState<string | null>(null);
  const me = b.writer?.accountId ?? null;
  const iAmProposed = !!me && c.pending_owner === me;
  return (
    <Panel title="Ownership">
      <dl className="kv left">
        <dt>Owner</dt><dd><Addr id={c.owner} explorer={b.explorer} full /></dd>
        <dt>Transfer</dt><dd>{c.pending_owner ? <>Offered to <Addr id={c.pending_owner} explorer={b.explorer} full />, waiting for them to accept</> : 'None in progress'}</dd>
      </dl>
      {iAmProposed && (
        <div className="detail-actions">
          <button className="btn primary" disabled={!!b.busy} onClick={() => b.act('You are now the vault owner', 'accept_ownership', {})}>
            {b.busy ? 'Waiting for confirmation…' : 'Accept ownership'}
          </button>
        </div>
      )}
      {b.isOwner && (
        <>
          <p className="muted small">Ownership moves in two steps: you offer it, and nothing changes until the new account accepts from its own wallet. A typo can’t hand the vault to an account nobody controls. For mainnet, use an account secured by a hardware wallet or a multisig.</p>
          <form className="owner-transfer" onSubmit={(e) => {
            e.preventDefault();
            const v = to.trim().toLowerCase();
            if (!ACCOUNT_RE.test(v) || v.length < 2 || v.length > 64) return setErr('Enter a valid NEAR account, like treasury.near.');
            if (v === c.owner) return setErr('That account is already the owner.');
            setErr(''); setReview(v);
          }}>
            <label className="field"><span>New owner account</span><input value={to} onChange={(e) => setTo(e.target.value)} spellCheck={false} placeholder={b.network === 'mainnet' ? 'treasury.near' : 'treasury.testnet'} /></label>
            <button className="btn">Offer ownership</button>
            {c.pending_owner && <button type="button" className="btn ghost" disabled={!!b.busy} onClick={() => b.act('Ownership offer cancelled', 'propose_owner', { new_owner: null })}>Cancel offer</button>}
          </form>
          {err && <div className="form-err" role="alert">{err}</div>}
        </>
      )}
      <Dialog open={!!review} title="Offer ownership?" onClose={() => setReview(null)}
        footer={<>
          <button className="btn" onClick={() => setReview(null)}>Cancel</button>
          <button className="btn primary" disabled={!!b.busy} onClick={async () => { if (await b.act(`Ownership offered to ${short(review!)}`, 'propose_owner', { new_owner: review })) { setReview(null); setTo(''); } }}>
            {b.busy ? 'Waiting for confirmation…' : 'Sign and offer'}
          </button>
        </>}>
        <ChangeSummary rows={[['Proposed owner', c.pending_owner ?? 'None', review ?? '']]} signer={me} network={b.network} />
        <p className="muted small">You stay the owner until {review} accepts. You can cancel the offer before then.</p>
      </Dialog>
    </Panel>
  );
}
