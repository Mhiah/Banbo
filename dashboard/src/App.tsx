import { useEffect, useState } from 'react';
import { BanboProvider, useBanbo } from './state';
import { NETWORKS, HOSTED, FACTORY } from './near';
import { short } from './format';
import { Empty, Skeleton } from './ui';
import Overview from './pages/Overview';
import Guide from './pages/Guide';
import Agents from './pages/Agents';
import Rules from './pages/Rules';
import Tasks from './pages/Tasks';
import Activity from './pages/Activity';
import Privacy from './pages/Privacy';
import Demo from './pages/Demo';
import CreateVault from './pages/CreateVault';
import ConnectAgent from './pages/ConnectAgent';
import Settings from './pages/Settings';

const ROUTES = [
  { path: 'overview', label: 'Overview', el: Overview },
  { path: 'guide', label: 'Guide', el: Guide },
  { path: 'agents', label: 'Agents', el: Agents },
  { path: 'tasks', label: 'Mandates', el: Tasks },
  { path: 'rules', label: 'Spending Rules', el: Rules },
  { path: 'activity', label: 'Activity', el: Activity },
  { path: 'privacy', label: 'Privacy', el: Privacy },
  { path: 'settings', label: 'Settings', el: Settings },
] as const;
const DEMO = { path: 'demo', label: 'Demo', el: Demo };
const CREATE = { path: 'new', label: 'Create a vault', el: CreateVault };
const CONNECT = { path: 'connect', label: 'Connect an agent', el: ConnectAgent };

function useRoute() {
  const read = () => window.location.hash.replace(/^#\/?/, '').split('?')[0] || 'overview';
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const on = () => setRoute(read());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}

export default function App() {
  return (
    <BanboProvider>
      <Shell />
    </BanboProvider>
  );
}

function Shell() {
  const b = useBanbo();
  const route = useRoute();
  const [navOpen, setNavOpen] = useState(false);
  useEffect(() => setNavOpen(false), [route]);

  const all = HOSTED ? [...ROUTES, CREATE, CONNECT] : [...ROUTES, CREATE, CONNECT, DEMO];
  const current = all.find((r) => r.path === route) ?? ROUTES[0];
  const Page = current.el;
  const needsVault = current.path !== 'settings' && current.path !== 'guide' && current.path !== 'demo' && current.path !== 'new';

  useEffect(() => { document.title = `${current.label} · Banbo`; }, [current.label]);

  return (
    <div className={`shell ${navOpen ? 'nav-open' : ''}`}>
      <a className="skip" href="#main">Skip to content</a>
      <aside className="sidebar" aria-label="Main navigation">
        <div className="side-top">
          <a href="#/overview" className="wordmark" aria-label="Banbo home">banbo<span>.</span></a>
          <button className="icon-btn nav-close" onClick={() => setNavOpen(false)} aria-label="Close menu">×</button>
        </div>
        <div className="vault-ctx">
          <div className="ctx-label">Vault</div>
          <div className="ctx-value mono" title={b.contractId}>{b.contractId ? short(b.contractId) : 'Not selected'}</div>
          {FACTORY[b.network] && <a className="link-btn xs" href="#/new">+ Create a vault</a>}
        </div>
        <nav>
          {ROUTES.map((r) => (
            <a key={r.path} href={`#/${r.path}`} className={current.path === r.path ? 'active' : ''} aria-current={current.path === r.path ? 'page' : undefined}>
              {r.label}
              {r.path === 'overview' && b.state && b.state.requests.some((x) => x.status === 'PendingApproval') && (
                <span className="nav-badge" aria-label="approvals waiting">{b.state.requests.filter((x) => x.status === 'PendingApproval').length}</span>
              )}
            </a>
          ))}
          {!HOSTED && <>
            <div className="nav-sep" />
            <a href="#/demo" className={current.path === 'demo' ? 'active' : ''} aria-current={current.path === 'demo' ? 'page' : undefined}>
              Demo <span className="nav-tag">dev</span>
            </a>
          </>}
        </nav>
        <div className="side-bottom">
          <div className={`net net-${b.network}`}>
            <span className="net-dot" aria-hidden />
            {b.network === 'sandbox' ? 'Local sandbox' : `NEAR ${NETWORKS[b.network].label}`}
          </div>
          <WalletBox />
        </div>
      </aside>
      <div className="scrim" onClick={() => setNavOpen(false)} />

      <div className="content">
        <div className="topbar">
          <button className="icon-btn menu" onClick={() => setNavOpen(true)} aria-label="Open menu">
            <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden><path d="M2 4h14M2 9h14M2 14h14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
          </button>
          <a href="#/overview" className="wordmark sm">banbo<span>.</span></a>
          {b.state?.config.paused && <span className="badge red top-paused"><span className="dot" />Vault paused</span>}
        </div>
        {b.state?.config.paused && current.path !== 'rules' && (
          <div className="alert danger" role="alert">
            <strong>All agent payments are paused.</strong> Every request is being rejected by the contract.
            {b.isOwner && <button className="btn sm" disabled={!!b.busy} onClick={() => b.act('Payments resumed', 'unpause')}>Resume payments</button>}
          </div>
        )}
        <main id="main" tabIndex={-1}>
          {needsVault ? <VaultGate><Page /></VaultGate> : <Page />}
        </main>
      </div>

      <div className="toasts" aria-live="polite">
        {b.toasts.map((t) => <div key={t.id} className={`toast ${t.kind}`} role={t.kind === 'err' ? 'alert' : 'status'}>{t.text}</div>)}
      </div>
    </div>
  );
}

function VaultGate({ children }: { children: React.ReactNode }) {
  const b = useBanbo();
  if (b.network === 'sandbox' && b.sandboxDown) {
    return (
      <Empty title="Start the local sandbox">
        <p>Local mode connects to a NEAR node running on your machine. In a terminal:</p>
        <pre>cd demo && npm install && npm run sandbox</pre>
        <p className="muted">It deploys a vault with three agents and keeps running. This page connects automatically.</p>
      </Empty>
    );
  }
  if (b.network !== 'sandbox' && !b.contractId) {
    return (
      <Empty title="Choose a vault" action={<div className="empty-actions">
        {FACTORY[b.network] && <a className="btn primary" href="#/new">Create a vault</a>}
        <a className={`btn ${FACTORY[b.network] ? '' : 'primary'}`} href="#/settings">Open an existing vault</a>
      </div>}>
        <p>Create a new Banbo vault with your wallet, or enter the account id of one you already have on NEAR {NETWORKS[b.network].label}.</p>
      </Empty>
    );
  }
  if (b.loadError && !b.state) {
    return (
      <Empty title="Couldn’t read this vault" action={<a className="btn" href="#/settings">Check settings</a>}>
        <p><span className="mono">{b.contractId}</span></p>
        <p className="muted">{b.loadError}</p>
      </Empty>
    );
  }
  if (!b.state) return <Skeleton rows={6} />;
  return <>{children}</>;
}

function WalletBox() {
  const b = useBanbo();
  if (b.network === 'sandbox') {
    return (
      <div className="wallet">
        <div className="ctx-label">Signed in as</div>
        <div className="mono small">{b.writer?.accountId ?? '-'}</div>
        <div className="muted xs">Local dev key, held by the sandbox process</div>
      </div>
    );
  }
  if (!b.handle) return null;
  if (!b.writer?.accountId) {
    return <button className="btn primary full" onClick={() => b.handle!.modal.show()}>Connect wallet</button>;
  }
  return (
    <div className="wallet">
      <div className="ctx-label">Wallet</div>
      <div className="mono small" title={b.writer.accountId}>{short(b.writer.accountId)}</div>
      <button className="link-btn xs" onClick={async () => (await b.handle!.selector.wallet()).signOut()}>Sign out</button>
    </div>
  );
}
