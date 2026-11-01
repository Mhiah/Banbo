import { useEffect, useState, type ReactNode } from 'react';
import { useBanbo } from '../state';
import type { Agent } from '../near';
import { near, toYocto, short } from '../format';
import { Panel, PageHeader, Addr, Amount, Dialog, ChangeSummary, Empty } from '../ui';

type Pending = { title: string; rows: [string, ReactNode, ReactNode][]; note?: ReactNode; label: string; method: string; args: object; danger?: boolean };

export default function Rules() {
  const b = useBanbo();
  const s = b.state!;
  const bal = s.balances;
  const [pending, setPending] = useState<Pending | null>(null);
  const [editCap, setEditCap] = useState(false);
  const [editAgent, setEditAgent] = useState<string | null>(null);
  const [newRecipient, setNewRecipient] = useState('');
  const [recErr, setRecErr] = useState('');
  const owner = b.isOwner;

  useEffect(() => {
    const q = new URLSearchParams(window.location.hash.split('?')[1] ?? '');
    const a = q.get('agent');
    if (a) setEditAgent(a);
  }, []);

  const used = BigInt(bal.shared_spent) + BigInt(bal.shared_reserved);
  const hours = Math.round(s.config.period_ms / 3_600_000);

  const submit = async () => {
    if (!pending) return;
    if (await b.act(pending.label, pending.method, pending.args)) setPending(null);
  };

  return (
    <>
      <PageHeader title="Spending Rules" subtitle="You decide what each agent can spend and where it can send funds. The contract enforces these rules on every payment." />
      {!owner && <div className="alert">You’re viewing these rules read-only. Only the vault owner ({short(s.config.owner)}) can change them.</div>}

      <Panel title="Shared daily limit" action={owner && <button className="btn" onClick={() => setEditCap(true)}>Change</button>}>
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
                    <td className="r act">{owner && <button className="btn sm" onClick={() => setEditAgent(id)}>Edit</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel title="Allowed recipients">
        <p className="muted">Agents can only send funds to these accounts. A payment to anyone else, including one an agent was tricked into, is rejected by the contract.</p>
        {s.allowlist.length === 0 ? <p className="muted"><em>No recipients allowed yet. Agents can’t pay anyone.</em></p> : (
          <ul className="list">
            {s.allowlist.map((r) => (
              <li key={r}>
                <Addr id={r} explorer={b.explorer} full />
                {owner && <button className="btn sm ghost" onClick={() => setPending({
                  title: 'Remove recipient?', label: `${short(r)} removed`, method: 'disallow_recipient', args: { recipient: r }, danger: true,
                  rows: [['Allowed', 'Yes', 'No']],
                  note: <>Agents will no longer be able to pay <span className="mono">{r}</span>. Payments already waiting for approval to this account can’t be approved.</>,
                })}>Remove</button>}
              </li>
            ))}
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

      <CapDialog open={editCap} onClose={() => setEditCap(false)} onReview={(p) => { setEditCap(false); setPending(p); }} />
      {editAgent && s.agents.find(([id]) => id === editAgent) && (
        <AgentDialog id={editAgent} agent={s.agents.find(([id]) => id === editAgent)![1]} onClose={() => setEditAgent(null)} onReview={(p) => { setEditAgent(null); setPending(p); }} />
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

function CapDialog({ open, onClose, onReview }: { open: boolean; onClose: () => void; onReview: (p: Pending) => void }) {
  const b = useBanbo();
  const bal = b.state!.balances;
  const [v, setV] = useState('');
  const [err, setErr] = useState('');
  useEffect(() => { if (open) { setV(near(bal.shared_cap).replace(/,/g, '')); setErr(''); } }, [open]); // eslint-disable-line
  const used = BigInt(bal.shared_spent) + BigInt(bal.shared_reserved);
  const left = (cap: bigint) => (cap > used ? cap - used : 0n).toString();
  return (
    <Dialog open={open} title="Change shared daily limit" onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" form="cap-form">Review</button></>}>
      <form id="cap-form" className="form" onSubmit={(e) => {
        e.preventDefault();
        try {
          const cap = toYocto(v);
          onReview({
            title: 'Review change', label: 'Shared daily limit updated', method: 'set_shared_cap', args: { shared_cap: cap },
            rows: [
              ['Shared daily limit', `${near(bal.shared_cap)} NEAR`, `${near(cap)} NEAR`],
              ['Left for today', `${near(left(BigInt(bal.shared_cap)))} NEAR`, `${near(left(BigInt(cap)))} NEAR`],
            ],
            note: BigInt(cap) < used ? 'This is below what’s already been used today, so agents can’t spend more until the next period.' : undefined,
          });
        } catch (x) { setErr((x as Error).message); }
      }}>
        <label className="field"><span>New limit (NEAR)</span><input value={v} onChange={(e) => setV(e.target.value)} inputMode="decimal" /></label>
        {err && <div className="form-err" role="alert">{err}</div>}
      </form>
    </Dialog>
  );
}

function AgentDialog({ id, agent, onClose, onReview }: { id: string; agent: Agent; onClose: () => void; onReview: (p: Pending) => void }) {
  const clean = (y: string) => near(y).replace(/,/g, '');
  const [f, setF] = useState({ perTx: clean(agent.per_tx_max), daily: clean(agent.period_limit), threshold: clean(agent.approval_threshold) });
  const [err, setErr] = useState('');
  const field = (k: keyof typeof f, label: string) => (
    <label className="field"><span>{label}</span><input value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} inputMode="decimal" /></label>
  );
  return (
    <Dialog open title={`Edit limits · ${short(id)}`} onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" form="agent-form">Review</button></>}>
      <form id="agent-form" className="form" onSubmit={(e) => {
        e.preventDefault();
        try {
          const args = { agent: id, per_tx_max: toYocto(f.perTx), period_limit: toYocto(f.daily), approval_threshold: toYocto(f.threshold) };
          if (BigInt(args.per_tx_max) > BigInt(args.period_limit)) throw new Error('Max per payment can’t be higher than the daily limit.');
          const row = (label: string, a: string, b: string): [string, ReactNode, ReactNode] => [label, `${near(a)} NEAR`, `${near(b)} NEAR`];
          onReview({
            title: 'Review change', label: `Limits updated for ${short(id)}`, method: 'add_agent', args,
            rows: [
              row('Max per payment', agent.per_tx_max, args.per_tx_max),
              row('Daily limit', agent.period_limit, args.period_limit),
              row('Needs approval above', agent.approval_threshold, args.approval_threshold),
            ],
            note: 'Today’s spending so far is kept. Saving also re-enables the agent if it was disabled.',
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
