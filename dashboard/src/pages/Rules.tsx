import { useEffect, useState, type ReactNode } from 'react';
import { useBanbo } from '../state';
import { NEAR_ASSET, assetOf, type Asset } from '../near';
import { near, units, toUnits, short, duration, until } from '../format';
import { Panel, PageHeader, Addr, Amount, Dialog, ChangeSummary, Empty } from '../ui';

type Pending = { title: string; rows: [string, ReactNode, ReactNode][]; note?: ReactNode; label: string; method: string; args: object; danger?: boolean };

export default function Rules() {
  const b = useBanbo();
  const s = b.state!;
  const bal = s.balances;
  const [pending, setPending] = useState<Pending | null>(null);
  const [editCap, setEditCap] = useState<string | null>(null); // 'NEAR' or token id
  const [editRisk, setEditRisk] = useState(false);
  const [editRetention, setEditRetention] = useState(false);
  const [editAgent, setEditAgent] = useState<{ id: string; token: string | null } | null>(null);
  const [newRecipient, setNewRecipient] = useState('');
  const [recErr, setRecErr] = useState('');
  const owner = b.isOwner;

  useEffect(() => {
    const q = new URLSearchParams(window.location.hash.split('?')[1] ?? '');
    const a = q.get('agent');
    if (a) setEditAgent({ id: a, token: null });
  }, []);

  const used = BigInt(bal.shared_spent) + BigInt(bal.shared_reserved);
  const hours = Math.round(s.config.period_ms / 3_600_000);

  const submit = async () => {
    if (!pending) return;
    if (await b.act(pending.label, pending.method, pending.args)) {
      if (pending.method === 'allow_recipient') setNewRecipient('');
      setPending(null);
    }
  };

  return (
    <>
      <PageHeader title="Spending Rules" subtitle="You decide what each agent can spend and where it can send funds. The contract enforces these rules on every payment." />

      <Panel title="Shared daily limit" action={owner && <button className="btn" onClick={() => setEditCap('NEAR')}>Change</button>}>
        <div className="rule-row">
          <div className="rule-value"><Amount yocto={bal.shared_cap} strong /></div>
          <div className="rule-desc">The most all agents together can spend in one {hours}-hour period. Today: <Amount yocto={used.toString()} /> used.</div>
        </div>
      </Panel>

      <Panel title="Per-agent limits" flush>
        {s.agents.length === 0 ? <Empty title="No agents registered" action={<a className="btn" href="#/agents">Go to agents</a>} /> : (
          <div className="table-wrap">
            <table className="table stack">
              <thead><tr><th>Agent</th><th className="r">Max per payment</th><th className="r">Daily limit</th><th className="r">Needs approval above</th><th /></tr></thead>
              <tbody>
                {s.agents.map(([id, a]) => (
                  <tr key={id}>
                    <td><span className="mono">{short(id)}</span>{!a.active && <span className="badge gray inline"><span className="dot" />Disabled</span>}</td>
                    <td className="r num" data-label="Max per payment">{near(a.per_tx_max)}</td>
                    <td className="r num" data-label="Daily limit">{near(a.period_limit)}</td>
                    <td className="r num" data-label="Needs approval above">{near(a.approval_threshold)}</td>
                    <td className="r act">{owner && <button className="btn sm" onClick={() => setEditAgent({ id, token: null })}>Edit</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {s.tokens.map((t) => {
        const asset = assetOf(s, t.token);
        const f = (v: string) => units(v, t.decimals);
        const tUsed = BigInt(t.shared_spent) + BigInt(t.shared_reserved);
        return (
          <Panel key={t.token} title={`${t.symbol} payments`} flush action={owner && <button className="btn" onClick={() => setEditCap(t.token)}>Change shared limit</button>}>
            <div className="rule-row pad">
              <div className="rule-value"><Amount yocto={t.shared_cap} asset={asset} strong /></div>
              <div className="rule-desc">Shared daily limit for {t.symbol} across all agents. Today: <Amount yocto={tUsed.toString()} asset={asset} /> used. Token contract <span className="mono">{short(t.token)}</span>.</div>
            </div>
            <div className="table-wrap">
              <table className="table stack">
                <thead><tr><th>Agent</th><th className="r">Max per payment</th><th className="r">Daily limit</th><th className="r">Needs approval above</th><th /></tr></thead>
                <tbody>
                  {s.agents.map(([id]) => {
                    const l = (s.tokenLimits[id] ?? []).find(([tok]) => tok === t.token)?.[1];
                    return (
                      <tr key={id}>
                        <td><span className="mono">{short(id)}</span></td>
                        {l ? <>
                          <td className="r num" data-label="Max per payment">{f(l.per_tx_max)}</td>
                          <td className="r num" data-label="Daily limit">{f(l.period_limit)}</td>
                          <td className="r num" data-label="Needs approval above">{f(l.approval_threshold)}</td>
                        </> : <td colSpan={3} className="muted" data-label={t.symbol}>Can’t pay in {t.symbol}</td>}
                        <td className="r act">{owner && <button className="btn sm" onClick={() => setEditAgent({ id, token: t.token })}>{l ? 'Edit' : 'Allow'}</button>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Panel>
        );
      })}

      <Panel title="Allowed recipients">
        <p className="muted">Agents can only send funds to these accounts. A payment to anyone else, including one an agent was tricked into, is rejected by the contract.{s.tokens.length > 0 && ' For token payments, the recipient must also be registered with the token contract, or the payment fails safely and the funds stay in the vault.'}</p>
        {s.allowlist.length === 0 ? <p className="muted"><em>No recipients allowed yet. Agents can’t pay anyone.</em></p> : (
          <ul className="list">
            {s.allowlist.map((r) => {
              const rec = s.recipients.find((x) => x.account === r);
              const cooling = rec && rec.payable_from_ms > b.now;
              return (
              <li key={r}>
                <span className="rcpt">
                  <Addr id={r} explorer={b.explorer} full />
                  {cooling && <span className="badge amber inline" title={`Payable from ${new Date(rec!.payable_from_ms).toLocaleString()}`}><span className="dot" />Cooldown · payable {until(rec!.payable_from_ms, b.now)}</span>}
                </span>
                {owner && <button className="btn sm ghost" onClick={() => setPending({
                  title: 'Remove recipient?', label: `${short(r)} removed`, method: 'disallow_recipient', args: { recipient: r }, danger: true,
                  rows: [['Allowed', 'Yes', 'No']],
                  note: <>Agents will no longer be able to pay <span className="mono">{r}</span>. Payments already waiting for approval to this account can’t be approved.</>,
                })}>Remove</button>}
              </li>
              );
            })}
          </ul>
        )}
        {owner && (
          <form className="inline-form" onSubmit={(e) => {
            e.preventDefault();
            const r = newRecipient.trim();
            if (!/^[a-z0-9._-]{2,64}$/.test(r)) return setRecErr('Enter a valid NEAR account id.');
            if (s.allowlist.includes(r)) return setRecErr('Already allowed.');
            setRecErr('');
            setPending({ title: 'Allow recipient?', label: `${short(r)} allowed`, method: 'allow_recipient', args: { recipient: r }, rows: [['Recipient', <span className="mono">{r}</span>, 'Allowed']], note: 'Every agent will be able to pay this account, within its limits.' });
          }}>
            <input value={newRecipient} onChange={(e) => setNewRecipient(e.target.value)} placeholder="vendor.near" aria-label="New recipient account" spellCheck={false} />
            <button className="btn">Add recipient</button>
          </form>
        )}
        {recErr && <div className="form-err" role="alert">{recErr}</div>}
      </Panel>

      <Panel title="Risk rules" action={owner && <button className="btn" onClick={() => setEditRisk(true)}>Change</button>}>
        <div className="risk-grid">
          <div>
            <div className="label">New recipient cooldown</div>
            <div className="rule-value">{duration(s.config.recipient_cooldown_ms)}</div>
            <p className="rule-desc">A recipient you allow can’t be paid until this has passed. If someone tricks you into adding their account, you have time to notice and remove it.</p>
          </div>
          <div>
            <div className="label">Payments per agent per hour</div>
            <div className="rule-value">{s.config.max_payments_per_hour || 'No limit'}</div>
            <p className="rule-desc">Stops many small payments from adding up, even when each one is within the amount limits.</p>
          </div>
        </div>
      </Panel>

      <Panel title="Approvals and records" action={owner && <button className="btn" onClick={() => setEditRetention(true)}>Change</button>}>
        <div className="risk-grid">
          <div>
            <div className="label">Approval window</div>
            <div className="rule-value">{duration(s.config.approval_ttl_ms)}</div>
            <p className="rule-desc">A payment waiting for your approval expires after this, and its reserved budget goes back to the agent. Nothing is sent.</p>
          </div>
          <div>
            <div className="label">Payment records kept</div>
            <div className="rule-value">{s.config.history_limit.toLocaleString()}</div>
            <p className="rule-desc">Older finished records are deleted from the contract, which returns their storage deposit to the vault. Every payment stays on the public chain history.</p>
          </div>
        </div>
      </Panel>

      <Panel title="Budget period">
        <div className="rule-row">
          <div className="rule-value">{hours} hours</div>
          <div className="rule-desc">Spending counters reset every {hours} hours. Payments still being sent at the reset keep counting until they settle. Set when the vault was deployed; it can’t be changed.</div>
        </div>
      </Panel>

      <Panel title="Emergency controls">
        <div className="rule-row">
          <div className="rule-value">{s.config.paused ? <span className="badge red"><span className="dot" />Paused</span> : <span className="badge green"><span className="dot" />Payments on</span>}</div>
          <div className="rule-desc">Pausing rejects every new agent payment immediately. Payments already being sent finish normally. To stop a single agent, disable it on the Agents page.</div>
          {owner && (s.config.paused
            ? <button className="btn primary" onClick={() => setPending({ title: 'Resume payments?', label: 'Payments resumed', method: 'unpause', args: {}, rows: [['Agent payments', 'Paused', 'On']] })}>Resume payments</button>
            : <button className="btn danger" onClick={() => setPending({ title: 'Pause all payments?', label: 'Payments paused', method: 'pause', args: {}, danger: true, rows: [['Agent payments', 'On', 'Paused']], note: 'Every agent request will be rejected until you resume.' })}>Pause all payments</button>)}
        </div>
      </Panel>

      {editRisk && <RiskDialog onClose={() => setEditRisk(false)} onReview={(p) => { setEditRisk(false); setPending(p); }} />}
      {editRetention && <RetentionDialog onClose={() => setEditRetention(false)} onReview={(p) => { setEditRetention(false); setPending(p); }} />}
      {editCap && <CapDialog which={editCap} onClose={() => setEditCap(null)} onReview={(p) => { setEditCap(null); setPending(p); }} />}
      {editAgent && s.agents.some(([id]) => id === editAgent.id) && (
        <AgentDialog id={editAgent.id} token={editAgent.token} onClose={() => setEditAgent(null)} onReview={(p) => { setEditAgent(null); setPending(p); }} />
      )}

      <Dialog open={!!pending} title={pending?.title ?? ''} onClose={() => setPending(null)}
        footer={<>
          <button className="btn" onClick={() => setPending(null)}>Cancel</button>
          <button className={`btn ${pending?.danger ? 'danger' : 'primary'}`} disabled={!!b.busy} onClick={submit}>{b.busy ? 'Waiting for confirmation…' : 'Sign and apply'}</button>
        </>}
      >
        {pending && <>
          <ChangeSummary rows={pending.rows} signer={b.writer?.accountId ?? null} network={b.network} />
          {pending.note && <p className="muted small">{pending.note}</p>}
        </>}
      </Dialog>
    </>
  );
}

function CapDialog({ which, onClose, onReview }: { which: string; onClose: () => void; onReview: (p: Pending) => void }) {
  const b = useBanbo();
  const s = b.state!;
  const t = which === 'NEAR' ? null : s.tokens.find((x) => x.token === which)!;
  const asset: Asset = t ? assetOf(s, t.token) : NEAR_ASSET;
  const cap = t ? t.shared_cap : s.balances.shared_cap;
  const used = t ? BigInt(t.shared_spent) + BigInt(t.shared_reserved) : BigInt(s.balances.shared_spent) + BigInt(s.balances.shared_reserved);
  const f = (v: string) => `${units(v, asset.decimals)} ${asset.symbol}`;
  const [v, setV] = useState(units(cap, asset.decimals).replace(/,/g, ''));
  const [err, setErr] = useState('');
  const left = (c: bigint) => (c > used ? c - used : 0n).toString();
  return (
    <Dialog open title={`Change ${t ? `${t.symbol} ` : ''}shared daily limit`} onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" form="cap-form">Review</button></>}>
      <form id="cap-form" className="form" onSubmit={(e) => {
        e.preventDefault();
        try {
          const next = toUnits(v, asset.decimals);
          onReview({
            title: 'Review change', label: `${t ? `${t.symbol} s` : 'S'}hared daily limit updated`,
            method: t ? 'add_token' : 'set_shared_cap',
            args: t ? { token: t.token, symbol: t.symbol, decimals: t.decimals, shared_cap: next } : { shared_cap: next },
            rows: [
              ['Shared daily limit', f(cap), f(next)],
              ['Left for today', f(left(BigInt(cap))), f(left(BigInt(next)))],
            ],
            note: BigInt(next) < used ? 'This is below what’s already been used today, so agents can’t spend more until the next period.' : undefined,
          });
        } catch (x) { setErr((x as Error).message); }
      }}>
        <label className="field"><span>New limit ({asset.symbol})</span><input value={v} onChange={(e) => setV(e.target.value)} inputMode="decimal" autoFocus /></label>
        {err && <div className="form-err" role="alert">{err}</div>}
      </form>
    </Dialog>
  );
}

function AgentDialog({ id, token, onClose, onReview }: { id: string; token: string | null; onClose: () => void; onReview: (p: Pending) => void }) {
  const b = useBanbo();
  const s = b.state!;
  const asset = assetOf(s, token);
  const current = token
    ? (s.tokenLimits[id] ?? []).find(([t]) => t === token)?.[1] ?? null
    : s.agents.find(([a]) => a === id)![1];
  const clean = (y: string) => units(y, asset.decimals).replace(/,/g, '');
  const [f, setF] = useState(current
    ? { perTx: clean(current.per_tx_max), daily: clean(current.period_limit), threshold: clean(current.approval_threshold) }
    : { perTx: '', daily: '', threshold: '' });
  const [err, setErr] = useState('');
  const field = (k: keyof typeof f, label: string) => (
    <label className="field"><span>{label} ({asset.symbol})</span><input value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} inputMode="decimal" /></label>
  );
  const fmt = (v: string) => `${units(v, asset.decimals)} ${asset.symbol}`;
  return (
    <Dialog open title={`${current ? 'Edit' : 'Allow'} ${token ? `${asset.symbol} ` : ''}limits · ${short(id)}`} onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" form="agent-form">Review</button></>}>
      <form id="agent-form" className="form" onSubmit={(e) => {
        e.preventDefault();
        try {
          const lim = { per_tx_max: toUnits(f.perTx, asset.decimals), period_limit: toUnits(f.daily, asset.decimals), approval_threshold: toUnits(f.threshold, asset.decimals) };
          if (BigInt(lim.per_tx_max) > BigInt(lim.period_limit)) throw new Error('Max per payment can’t be higher than the daily limit.');
          const row = (label: string, a: string | undefined, n: string): [string, ReactNode, ReactNode] => [label, a ? fmt(a) : 'None', fmt(n)];
          onReview({
            title: 'Review change', label: `${token ? `${asset.symbol} l` : 'L'}imits updated for ${short(id)}`,
            method: token ? 'set_agent_token_limits' : 'add_agent',
            args: token ? { agent: id, token, ...lim } : { agent: id, ...lim },
            rows: [
              row('Max per payment', current?.per_tx_max, lim.per_tx_max),
              row('Daily limit', current?.period_limit, lim.period_limit),
              row('Needs approval above', current?.approval_threshold, lim.approval_threshold),
            ],
            note: token
              ? (current ? 'Today’s spending so far is kept.' : `This agent will be able to pay allowed recipients in ${asset.symbol}, within these limits.`)
              : 'Today’s spending so far is kept. Saving also re-enables the agent if it was disabled.',
          });
        } catch (x) { setErr((x as Error).message); }
      }}>
        <div className="form-row">
          {field('perTx', 'Max per payment')}
          {field('daily', 'Daily limit')}
          {field('threshold', 'Approval above')}
        </div>
        {err && <div className="form-err" role="alert">{err}</div>}
      </form>
    </Dialog>
  );
}

function RiskDialog({ onClose, onReview }: { onClose: () => void; onReview: (p: Pending) => void }) {
  const b = useBanbo();
  const c = b.state!.config;
  const [minutes, setMinutes] = useState(String(c.recipient_cooldown_ms / 60_000));
  const [rate, setRate] = useState(String(c.max_payments_per_hour));
  const [err, setErr] = useState('');
  return (
    <Dialog open title="Change risk rules" onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" form="risk-form">Review</button></>}>
      <form id="risk-form" className="form" onSubmit={(e) => {
        e.preventDefault();
        const m = Number(minutes), r = Number(rate);
        if (!Number.isFinite(m) || m < 0 || m > 43_200) return setErr('Cooldown must be between 0 and 43,200 minutes (30 days).');
        if (!Number.isInteger(r) || r < 0 || r > 10_000) return setErr('Payments per hour must be a whole number from 0 to 10,000.');
        const ms = Math.round(m * 60_000);
        onReview({
          title: 'Review change', label: 'Risk rules updated', method: 'set_risk_rules',
          args: { recipient_cooldown_ms: ms, max_payments_per_hour: r },
          rows: [
            ['New recipient cooldown', duration(c.recipient_cooldown_ms), duration(ms)],
            ['Payments per agent per hour', String(c.max_payments_per_hour || 'No limit'), String(r || 'No limit')],
          ],
          note: ms > c.recipient_cooldown_ms
            ? 'A longer cooldown applies to recipients you allow from now on. Recipients already allowed keep theirs.'
            : ms < c.recipient_cooldown_ms ? 'A shorter cooldown also shortens it for recipients already waiting.' : undefined,
        });
      }}>
        <div className="form-row">
          <label className="field"><span>New recipient cooldown (minutes, 0 = off)</span><input value={minutes} onChange={(e) => setMinutes(e.target.value)} inputMode="decimal" autoFocus /></label>
          <label className="field"><span>Payments per agent per hour (0 = no limit)</span><input value={rate} onChange={(e) => setRate(e.target.value)} inputMode="numeric" /></label>
        </div>
        {err && <div className="form-err" role="alert">{err}</div>}
      </form>
    </Dialog>
  );
}

function RetentionDialog({ onClose, onReview }: { onClose: () => void; onReview: (p: Pending) => void }) {
  const b = useBanbo();
  const c = b.state!.config;
  const [hours, setHours] = useState(String(c.approval_ttl_ms / 3_600_000));
  const [limit, setLimit] = useState(String(c.history_limit));
  const [err, setErr] = useState('');
  return (
    <Dialog open title="Change approvals and records" onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" form="retention-form">Review</button></>}>
      <form id="retention-form" className="form" onSubmit={(e) => {
        e.preventDefault();
        const h = Number(hours), n = Number(limit);
        if (!Number.isFinite(h) || h * 60 < 1 || h > 720) return setErr('The approval window must be between 1 minute and 720 hours (30 days).');
        if (!Number.isInteger(n) || n < 100 || n > 10_000) return setErr('Records kept must be a whole number from 100 to 10,000.');
        const ms = Math.round(h * 3_600_000);
        if (ms === c.approval_ttl_ms && n === c.history_limit) return onClose();
        // Two settings, two methods: review whichever changed (the TTL first).
        if (ms !== c.approval_ttl_ms) {
          onReview({
            title: 'Review change', label: 'Approval window updated', method: 'set_approval_ttl', args: { approval_ttl_ms: ms },
            rows: [['Approval window', duration(c.approval_ttl_ms), duration(ms)]],
            note: n !== c.history_limit ? 'Change the records setting again after this one.' : 'Payments already waiting keep the deadline they were given.',
          });
        } else {
          onReview({
            title: 'Review change', label: 'Records setting updated', method: 'set_history_limit', args: { history_limit: n },
            rows: [['Payment records kept', c.history_limit.toLocaleString(), n.toLocaleString()]],
            note: n < c.history_limit ? 'Older records are deleted a few at a time as new payments come in.' : undefined,
          });
        }
      }}>
        <div className="form-row">
          <label className="field"><span>Approval window (hours)</span><input value={hours} onChange={(e) => setHours(e.target.value)} inputMode="decimal" autoFocus /></label>
          <label className="field"><span>Payment records kept (100 to 10,000)</span><input value={limit} onChange={(e) => setLimit(e.target.value)} inputMode="numeric" /></label>
        </div>
        {err && <div className="form-err" role="alert">{err}</div>}
      </form>
    </Dialog>
  );
}
