import { useEffect, useRef, useState } from 'react';
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
          <a href="#/overview" className="wordmark" aria-label="Banbo home">Banbo<span>.</span></a>
          <button className="icon-btn nav-close" onClick={() => setNavOpen(false)} aria-label="Close menu">×</button>
        </div>
        {b.contractId && (
          <div className="vault-ctx">
            <div className="ctx-label">Vault</div>
            <div className="ctx-value mono" title={b.contractId}>{b.contractId ? short(b.contractId) : 'Not selected'}</div>
          </div>
        )}
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
      </aside>
      <div className="scrim" onClick={() => setNavOpen(false)} />

      <div className="content">
        <div className="topbar">
          <button className="icon-btn menu" onClick={() => setNavOpen(true)} aria-label="Open menu">
            <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden><path d="M2 4h14M2 9h14M2 14h14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
          </button>
          <a href="#/overview" className="wordmark sm">Banbo<span>.</span></a>
          {b.state?.config.paused && <span className="badge red top-paused"><span className="dot" />Vault paused</span>}
          <div className="top-right">
            <div className={`net net-${b.network}`} title={b.network === 'sandbox' ? 'Local sandbox' : `NEAR ${NETWORKS[b.network].label}`}>
              <span className="net-dot" aria-hidden />
              <span className="net-label">{b.network === 'sandbox' ? 'Local sandbox' : `NEAR ${NETWORKS[b.network].label}`}</span>
            </div>
            <WalletBox />
          </div>
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
  if (b.network !== 'sandbox' && !b.contractId && !b.writer?.accountId) {
    return (
      <Empty title="Connect your wallet" action={<div className="empty-actions">
        {b.handle && <button className="btn primary" onClick={() => b.handle!.modal.show()}>Connect wallet</button>}
        <a className="btn" href="#/guide">Read the guide</a>
      </div>} />
    );
  }
  if (b.network !== 'sandbox' && !b.contractId) {
    if (b.finding) return <Skeleton rows={6} />;
    return (
      <Empty title="You don’t have a vault yet" action={FACTORY[b.network] ? <a className="btn primary" href="#/new">Create a vault</a> : undefined}>
        <p>{FACTORY[b.network] ? 'Create one with your wallet to get started.' : `Vault creation isn’t available on NEAR ${NETWORKS[b.network].label} yet.`}</p>
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
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const off = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', off);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', off); document.removeEventListener('keydown', esc); };
  }, [open]);
  if (b.network === 'sandbox') {
    return <div className="wallet" title="Local dev key, held by the sandbox process"><span className="mono">{b.writer?.accountId ? short(b.writer.accountId) : '-'}</span></div>;
  }
  if (!b.handle) return null;
  if (!b.writer?.accountId) {
    return <button className="btn primary sm" onClick={() => b.handle!.modal.show()}>Connect wallet</button>;
  }
  return (
    <div className="wallet" ref={box}>
      <button className="wallet-id mono" title={b.writer.accountId} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        {short(b.writer.accountId)}<span className="caret" aria-hidden>▾</span>
      </button>
      {open && (
        <div className="wallet-menu" role="menu">
          <button role="menuitem" onClick={async () => { setOpen(false); (await b.handle!.selector.wallet()).signOut(); }}>Sign out</button>
        </div>
      )}
    </div>
  );
}
