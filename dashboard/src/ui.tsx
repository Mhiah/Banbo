import { useEffect, useRef, type ReactNode } from 'react';
import { STATUS, type Kind } from './activity';
import { near, units, pct, short } from './format';
import { NEAR_ASSET, type Asset } from './near';

export function Panel({ title, action, children, flush, id }: { title?: ReactNode; action?: ReactNode; children: ReactNode; flush?: boolean; id?: string }) {
  return (
    <section className={`panel ${flush ? 'flush' : ''}`} id={id}>
      {(title || action) && (
        <div className="panel-head">
          {title && <h2>{title}</h2>}
          {action && <div className="panel-action">{action}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

export function PageHeader({ title, subtitle, action }: { title: string; subtitle?: string; action?: ReactNode }) {
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        {subtitle && <p>{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

export function StatusBadge({ kind }: { kind: Kind }) {
  const s = STATUS[kind];
  return (
    <span className={`badge ${s.tone}`} title={s.help}>
      <span className="dot" aria-hidden />
      {s.label}
    </span>
  );
}

export function Addr({ id, explorer, full }: { id: string; explorer?: string; full?: boolean }) {
  if (!id) return <span className="muted">-</span>;
  const text = full ? id : short(id);
  return explorer
    ? <a className="mono link" href={`${explorer}/address/${id}`} target="_blank" rel="noreferrer" title={id}>{text}</a>
    : <span className="mono" title={id}>{text}</span>;
}

/** An amount with its unit. Pass `asset` for tokens; NEAR otherwise. */
export function Amount({ yocto, unit, asset, strong }: { yocto: string; unit?: string; asset?: Asset; strong?: boolean }) {
  const a = asset ?? NEAR_ASSET;
  return <span className={`num ${strong ? 'strong' : ''}`}>{units(yocto, a.decimals)}<span className="unit"> {unit ?? a.symbol}</span></span>;
}

/** Spent / reserved / available on one bar, with a legend (not color alone). */
export function BudgetBar({ spent, reserved, cap, asset = NEAR_ASSET }: { spent: string; reserved: string; cap: string; asset?: Asset }) {
  const f = (v: string) => units(v, asset.decimals);
  const s = pct(spent, cap);
  const r = Math.min(100 - s, pct(reserved, cap));
  const left = (BigInt(cap) - BigInt(spent) - BigInt(reserved));
  const available = left > 0n ? left.toString() : '0';
  return (
    <div className="budget">
      <div className="budget-bar" role="img" aria-label={`Spent ${f(spent)}, reserved ${f(reserved)}, available ${f(available)} of ${f(cap)} ${asset.symbol}`}>
        <span className="seg spent" style={{ width: `${s}%` }} />
        <span className="seg reserved" style={{ width: `${r}%` }} />
      </div>
      <dl className="budget-legend">
        <div><dt><i className="sw spent" />Spent</dt><dd><Amount yocto={spent} asset={asset} /></dd></div>
        <div><dt><i className="sw reserved" />Reserved</dt><dd><Amount yocto={reserved} asset={asset} /></dd></div>
        <div><dt><i className="sw available" />Available</dt><dd><Amount yocto={available} asset={asset} /></dd></div>
      </dl>
    </div>
  );
}

export function MiniBar({ value, max }: { value: string; max: string }) {
  return <span className="minibar" aria-hidden><span style={{ width: `${pct(value, max)}%` }} /></span>;
}

export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-title">{title}</div>
      {children && <div className="empty-body">{children}</div>}
      {action}
    </div>
  );
}

export function Skeleton({ rows = 3 }: { rows?: number }) {
  return <div className="skeleton" aria-busy="true" aria-label="Loading">{Array.from({ length: rows }, (_, i) => <span key={i} />)}</div>;
}

/** Accessible dialog: focus trap-lite, Escape to close, returns focus. */
export function Dialog({ open, title, onClose, children, footer }: { open: boolean; title: string; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>('input, button, [tabindex]')?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); prev?.focus(); };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        <div className="dialog-head">
          <h3>{title}</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="dialog-body">{children}</div>
        {footer && <div className="dialog-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function Drawer({ open, title, onClose, children }: { open: boolean; title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="overlay right" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside className="drawer" role="dialog" aria-modal="true" aria-label={title}>
        <div className="dialog-head">
          <h3>{title}</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="drawer-body">{children}</div>
      </aside>
    </div>
  );
}

/** Old → new rows shown before any policy change is signed. */
export function ChangeSummary({ rows, signer, network }: { rows: [string, ReactNode, ReactNode][]; signer: string | null; network: string }) {
  return (
    <>
      <table className="change">
        <thead><tr><th /><th>Current</th><th>New</th></tr></thead>
        <tbody>
          {rows.map(([label, a, b]) => (
            <tr key={label}><th scope="row">{label}</th><td>{a}</td><td className="new">{b}</td></tr>
          ))}
        </tbody>
      </table>
      <p className="sign-note">
        {network === 'sandbox'
          ? <>Signed by the local sandbox owner key. The change appears once the transaction is confirmed.</>
          : <>Your wallet{signer ? <> (<span className="mono">{short(signer)}</span>)</> : null} will ask you to sign. The change appears once the transaction is confirmed on-chain.</>}
      </p>
    </>
  );
}
