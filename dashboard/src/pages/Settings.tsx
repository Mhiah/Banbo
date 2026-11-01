import { useBanbo } from '../state';
import { NETWORKS, SANDBOX_API, type NetworkId } from '../near';
import { Panel, PageHeader, Addr } from '../ui';

export default function Settings() {
  const b = useBanbo();
  return (
    <>
      <PageHeader title="Settings" subtitle="Choose the network and vault this dashboard manages." />
      <Panel title="Network">
        <div className="radio-list" role="radiogroup" aria-label="Network">
          {(Object.keys(NETWORKS) as NetworkId[]).map((n) => (
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
