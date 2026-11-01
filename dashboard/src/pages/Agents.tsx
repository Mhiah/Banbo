import { useState } from 'react';
import { useBanbo } from '../state';
import { activity } from '../activity';
import type { Agent } from '../near';
import { near, units, toYocto, ago, reasonText, short } from '../format';
import { assetOf } from '../near';
import { Panel, PageHeader, StatusBadge, Addr, Amount, MiniBar, Empty, Dialog, Drawer, ChangeSummary } from '../ui';

export default function Agents() {
  const b = useBanbo();
  const s = b.state!;
  const [selected, setSelected] = useState<string | null>(null);
  const [registering, setRegistering] = useState(false);
  const sel = s.agents.find(([id]) => id === selected);

  return (
    <>
      <PageHeader
        title="Agents"
        subtitle="Each agent spends from the shared vault within its own limits."
        action={b.isOwner && <button className="btn primary" onClick={() => setRegistering(true)}>Register agent</button>}
      />
      <Panel flush>
        {s.agents.length === 0 ? (
          <Empty title="No agents registered" action={b.isOwner && <button className="btn primary" onClick={() => setRegistering(true)}>Register an agent</button>}>
            <p>Register the NEAR account your agent runs as, then give that account a key that can only call <code>request_payment</code> on this vault.</p>
          </Empty>
        ) : (
          <div className="table-wrap">
            <table className="table hover stack">
              <thead>
                <tr>
                  <th>Agent</th><th className="r">Per payment</th><th className="r">Daily limit</th>
                  <th className="r">Used today</th><th className="r">Approval above</th><th>Status</th>
                </tr>
              </thead>
              <tbody>
                {s.agents.map(([id, a]) => {
                  const used = (BigInt(a.spent) + BigInt(a.reserved)).toString();
                  return (
                    <tr key={id} tabIndex={0} onClick={() => setSelected(id)} onKeyDown={(e) => e.key === 'Enter' && setSelected(id)} aria-label={`Open ${id}`}>
                      <td><span className="mono">{short(id)}</span></td>
                      <td className="r num" data-label="Per payment">{near(a.per_tx_max)}</td>
                      <td className="r num" data-label="Daily limit">{near(a.period_limit)}</td>
                      <td className="r nowrap" data-label="Used today"><span className="num">{near(used)}</span> <MiniBar value={used} max={a.period_limit} /></td>
                      <td className="r num" data-label="Approval above">{near(a.approval_threshold)}</td>
                      <td className="st" data-label="Status">{a.active ? <span className="badge green"><span className="dot" />Active</span> : <span className="badge gray"><span className="dot" />Disabled</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      <p className="footnote">Limits in NEAR. Token limits, such as USDC, are on each agent’s page. “Used today” includes payments that are reserved but not yet confirmed.</p>

      <Drawer open={!!sel} title={sel ? short(sel[0]) : ''} onClose={() => setSelected(null)}>
        {sel && <AgentDetail id={sel[0]} agent={sel[1]} />}
      </Drawer>
      <RegisterAgent open={registering} onClose={() => setRegistering(false)} />
    </>
  );
}

function AgentDetail({ id, agent }: { id: string; agent: Agent }) {
  const b = useBanbo();
  const s = b.state!;
  const used = (BigInt(agent.spent) + BigInt(agent.reserved)).toString();
  const items = activity(s).filter((i) => i.agent === id).slice(0, 12);
  const [confirm, setConfirm] = useState(false);

  return (
    <>
      <div className="detail-status">
        {agent.active ? <span className="badge green"><span className="dot" />Active</span> : <span className="badge gray"><span className="dot" />Disabled</span>}
        <Addr id={id} explorer={b.explorer} full />
      </div>
      <dl className="kv">
        <dt>Spent today</dt><dd><Amount yocto={agent.spent} /></dd>
        <dt>Reserved</dt><dd><Amount yocto={agent.reserved} /></dd>
        <dt>Daily limit</dt><dd><Amount yocto={agent.period_limit} /></dd>
        <dt>Max per payment</dt><dd><Amount yocto={agent.per_tx_max} /></dd>
        <dt>Needs approval above</dt><dd><Amount yocto={agent.approval_threshold} /></dd>
        <dt>Payments this hour</dt><dd>{s.rates[id]?.count ?? 0}{s.config.max_payments_per_hour ? ` of ${s.config.max_payments_per_hour}` : ''}</dd>
        <dt>Can pay</dt><dd>{s.allowlist.length} allowed recipient{s.allowlist.length === 1 ? '' : 's'} (shared by all agents)</dd>
      </dl>
      <div className="bar-row"><MiniBar value={used} max={agent.period_limit} /><span className="muted small">{near(used)} of {near(agent.period_limit)} NEAR used</span></div>
      {s.tokens.length > 0 && (
        <>
          <h4>Token limits</h4>
          {(s.tokenLimits[id] ?? []).length === 0 ? <p className="muted small">This agent can only pay in NEAR.</p> : (
            <ul className="token-limits">
              {(s.tokenLimits[id] ?? []).map(([token, l]) => {
                const a = assetOf(s, token);
                const u = (BigInt(l.spent) + BigInt(l.reserved)).toString();
                return (
                  <li key={token}>
                    <div className="tl-head"><strong>{a.symbol}</strong><span className="muted small">{units(u, a.decimals)} of {units(l.period_limit, a.decimals)} used today</span></div>
                    <MiniBar value={u} max={l.period_limit} />
                    <div className="muted xs">Max {units(l.per_tx_max, a.decimals)} per payment · approval above {units(l.approval_threshold, a.decimals)}</div>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}

      {b.isOwner && (
        <div className="detail-actions">
          <a className="btn" href={`#/rules?agent=${encodeURIComponent(id)}`}>Edit limits</a>
          <button className={`btn ${agent.active ? 'danger' : 'primary'}`} disabled={!!b.busy} onClick={() => setConfirm(true)}>
            {agent.active ? 'Disable agent' : 'Re-enable agent'}
          </button>
        </div>
      )}

      <h4>Recent activity</h4>
      {items.length === 0 ? <p className="muted">No payments from this agent yet.</p> : (
        <ul className="mini-feed">
          {items.map((i) => (
            <li key={i.id}>
              <div><Amount yocto={i.amount} asset={i.asset} /> → <span className="mono">{short(i.recipient)}</span>
                {i.reason && <div className="reason">{reasonText(i.reason)}</div>}
              </div>
              <div className="r"><StatusBadge kind={i.kind} /><div className="muted xs">{ago(i.at, b.now)}</div></div>
            </li>
          ))}
        </ul>
      )}

      <Dialog
        open={confirm}
        title={agent.active ? 'Disable this agent?' : 'Re-enable this agent?'}
        onClose={() => setConfirm(false)}
        footer={<>
          <button className="btn" onClick={() => setConfirm(false)}>Cancel</button>
          <button className={`btn ${agent.active ? 'danger' : 'primary'}`} disabled={!!b.busy}
            onClick={async () => { if (await b.act(agent.active ? `${short(id)} disabled` : `${short(id)} re-enabled`, 'set_agent_active', { agent: id, active: !agent.active })) setConfirm(false); }}>
            {b.busy ? 'Waiting for confirmation…' : agent.active ? 'Disable' : 'Re-enable'}
          </button>
        </>}
      >
        <ChangeSummary rows={[['Status', agent.active ? 'Active' : 'Disabled', agent.active ? 'Disabled' : 'Active']]} signer={b.writer?.accountId ?? null} network={b.network} />
        {agent.active && <p className="muted small">New payment requests from this agent will be rejected. Payments already being sent still settle normally.</p>}
      </Dialog>
    </>
  );
}

function RegisterAgent({ open, onClose }: { open: boolean; onClose: () => void }) {
  const b = useBanbo();
  const [f, setF] = useState({ agent: '', perTx: '0.5', daily: '3', threshold: '0.4' });
  const [err, setErr] = useState('');
  const [review, setReview] = useState<null | { agent: string; per_tx_max: string; period_limit: string; approval_threshold: string }>(null);

  const close = () => { setReview(null); setErr(''); onClose(); };
  const next = (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const agent = f.agent.trim();
      if (!/^[a-z0-9._-]{2,64}$/.test(agent)) throw new Error('Enter a valid NEAR account id, e.g. agent.yourname.near');
      const args = { agent, per_tx_max: toYocto(f.perTx), period_limit: toYocto(f.daily), approval_threshold: toYocto(f.threshold) };
      if (BigInt(args.per_tx_max) > BigInt(args.period_limit)) throw new Error('Max per payment can’t be higher than the daily limit.');
      setErr(''); setReview(args);
    } catch (x) { setErr((x as Error).message); }
  };
  const field = (k: keyof typeof f, label: string, hint?: string, ph = '') => (
    <label className="field">
      <span>{label}</span>
      <input value={f[k]} placeholder={ph} onChange={(e) => setF({ ...f, [k]: e.target.value })} spellCheck={false} inputMode={k === 'agent' ? 'text' : 'decimal'} />
      {hint && <small>{hint}</small>}
    </label>
  );

  return (
    <Dialog open={open} title={review ? 'Review new agent' : 'Register agent'} onClose={close}
      footer={review ? <>
        <button className="btn" onClick={() => setReview(null)}>Back</button>
        <button className="btn primary" disabled={!!b.busy} onClick={async () => { if (await b.act(`Agent ${short(review.agent)} registered`, 'add_agent', review)) close(); }}>
          {b.busy ? 'Waiting for confirmation…' : 'Sign and register'}
        </button>
      </> : <>
        <button className="btn" onClick={close}>Cancel</button>
        <button className="btn primary" form="reg-agent">Review</button>
      </>}
    >
      {!review ? (
        <form id="reg-agent" className="form" onSubmit={next}>
          {field('agent', 'Agent account', 'The NEAR account your agent signs requests from.', 'agent.yourname.near')}
          <div className="form-row">
            {field('perTx', 'Max per payment', 'NEAR')}
            {field('daily', 'Daily limit', 'NEAR')}
            {field('threshold', 'Approval above', 'NEAR')}
          </div>
          {err && <div className="form-err" role="alert">{err}</div>}
        </form>
      ) : (
        <>
          <ChangeSummary
            rows={[
              ['Agent', '-', <span className="mono">{review.agent}</span>],
              ['Max per payment', '-', `${near(review.per_tx_max)} NEAR`],
              ['Daily limit', '-', `${near(review.period_limit)} NEAR`],
              ['Approval above', '-', `${near(review.approval_threshold)} NEAR`],
            ]}
            signer={b.writer?.accountId ?? null} network={b.network}
          />
          <div className="note">
            <strong>After registering:</strong> give the agent account a function-call key limited to this vault’s <code>request_payment</code> method, so the agent can’t move funds any other way.
            <pre>{`near account add-key ${review.agent} grant-function-call-access \\
  --allowance '0.25 NEAR' --contract-account-id ${b.contractId} \\
  --function-names request_payment autogenerate-new-keypair \\
  save-to-keychain network-config ${b.network === 'mainnet' ? 'mainnet' : 'testnet'} sign-with-keychain send`}</pre>
          </div>
        </>
      )}
    </Dialog>
  );
}
