import { useState, type FormEvent } from 'react';
import { useBanbo } from '../state';
import { assetOf, type Task } from '../near';
import { toUnits, short, until } from '../format';
import { Panel, PageHeader, Addr, Amount, BudgetBar, Empty, Dialog, ChangeSummary } from '../ui';

const ACCOUNT = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
const SOURCE = /^(email|web|doc|api):[!-~]{1,94}$/;
const list = (s: string) => s.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);

function taskState(t: Task, now: number): { label: string; tone: 'green' | 'gray' | 'amber' } {
  if (t.closed) return { label: 'Closed', tone: 'gray' };
  if (now >= t.expires_at_ms) return { label: 'Ended', tone: 'gray' };
  return { label: 'Open', tone: 'green' };
}

export default function Tasks() {
  const b = useBanbo();
  const s = b.state!;
  const owner = b.isOwner;
  const [creating, setCreating] = useState(false);
  const [closing, setClosing] = useState<Task | null>(null);
  const [vouch, setVouch] = useState<{ agent: string; on: boolean } | null>(null);
  const [policy, setPolicy] = useState<boolean | null>(null);
  const tasks = [...s.tasks].sort((a, c) => Number(a.closed) - Number(c.closed) || c.created_at_ms - a.created_at_ms);

  const trustOf = (agent: string) => {
    const tee = s.agentTee[agent];
    if (tee && tee.valid_until_ms > b.now && s.tee.measurements.some(([id]) => id === tee.measurement_id)) return { label: 'Verified TEE agent', tone: 'green' };
    if (s.vouched.includes(agent)) return { label: 'Vouched for by you', tone: 'amber' };
    return { label: 'Labels not accepted', tone: 'gray' };
  };

  return (
    <>
      <PageHeader
        title="Task mandates"
        subtitle="A task mandate gives an agent one job: who it may pay, how much, until when, and which senders may set an amount. The vault pays only the payees you set, and holds any amount that came from a source you don’t trust."
        action={owner && <button className="btn primary" onClick={() => setCreating(true)}>New mandate</button>}
      />

      <Panel title="How origin checks work">
        <p className="small">
          The agent runs a planner that only sees your request, and a separate reader for emails, web pages and files. Every recipient and
          amount carries a label saying where it came from. The contract refuses a recipient that came from a document, refuses anyone outside the
          mandate’s payees, and holds an amount that came from a source you haven’t trusted, showing you the exact message.
        </p>
        <p className="muted xs">
          Based on CaMeL, “Defeating Prompt Injections by Design” (Debenedetti et al., Google, Google DeepMind and ETH Zurich, 2025).
          Banbo enforces its policy in the vault contract. <a className="link" href="https://arxiv.org/abs/2503.18813" target="_blank" rel="noreferrer">Read the paper ↗</a>
        </p>
      </Panel>

      <Panel title="Mandates" flush>
        {tasks.length === 0 ? (
          <Empty title="No mandates yet" action={owner && <button className="btn" onClick={() => setCreating(true)}>Create a mandate</button>}>
            A mandate names the agent, who it may pay, how much, until when, and which senders you trust for amounts.
          </Empty>
        ) : (
          <ul className="tasks">
            {tasks.map((t) => {
              const asset = assetOf(s, t.token);
              const st = taskState(t, b.now);
              return (
                <li key={t.id} className="task">
                  <div className="task-head">
                    <div>
                      <span className="mono strong">{t.id}</span>
                      <span className={`badge inline ${st.tone}`}><span className="dot" />{st.label}</span>
                    </div>
                    {owner && (
                      <div className="task-actions">
                        {!t.closed && <button className="btn" disabled={!!b.busy} onClick={() => setClosing(t)}>Close</button>}
                        {(t.closed || b.now >= t.expires_at_ms) && BigInt(t.reserved) === 0n && (
                          <button className="btn" disabled={!!b.busy} onClick={() => b.act(`Mandate ${t.id} removed`, 'remove_task', { id: t.id })} title="Delete the record and free its storage">Remove</button>
                        )}
                      </div>
                    )}
                  </div>
                  {t.description && <p className="small">{t.description}</p>}
                  <BudgetBar spent={t.spent} reserved={t.reserved} cap={t.budget} asset={asset} />
                  <dl className="kv task-kv">
                    <dt>Agent</dt><dd><Addr id={t.agent} explorer={b.explorer} /></dd>
                    <dt>Pays only</dt><dd>{t.payees.map((p) => <div key={p}><Addr id={p} explorer={b.explorer} /></div>)}</dd>
                    <dt>Max per payment</dt><dd><Amount yocto={t.max_per_payment} asset={asset} /></dd>
                    <dt>Amounts trusted from</dt><dd>{t.trusted_sources.length ? t.trusted_sources.map((x) => <span key={x} className="badge gray chip mono">{x}</span>) : <span className="muted">Nobody: every amount from a document waits for you</span>}</dd>
                    <dt>Ends</dt><dd>{new Date(t.expires_at_ms).toLocaleString()}{t.expires_at_ms > b.now && <span className="muted"> ({until(t.expires_at_ms, b.now)})</span>}</dd>
                  </dl>
                </li>
              );
            })}
          </ul>
        )}
      </Panel>

      <Panel title="Who may send origin labels">
        <p className="small">
          The contract only believes an agent’s labels if it proved its code with an Intel TDX attestation, checked on-chain, or if you vouch for it
          (for example, a runtime on your own server). Each payment records which one applied.
        </p>
        {s.agents.length === 0 ? <p className="muted small">No agents yet.</p> : (
          <div className="table-wrap">
            <table className="table stack">
              <thead><tr><th>Agent</th><th>Labels</th><th /></tr></thead>
              <tbody>
                {s.agents.map(([id]) => {
                  const tr = trustOf(id);
                  const vouched = s.vouched.includes(id);
                  return (
                    <tr key={id}>
                      <td className="mono">{short(id)}</td>
                      <td data-label="Labels"><span className={`badge ${tr.tone}`}><span className="dot" />{tr.label}</span></td>
                      <td className="r">{owner && <button className="btn" disabled={!!b.busy} onClick={() => setVouch({ agent: id, on: !vouched })}>{vouched ? 'Stop vouching' : 'Vouch'}</button>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <div className="rule-row origin-policy">
          <div className="rule-desc">
            <strong>Require origin labels on every payment:</strong> {s.config.require_origin ? 'On' : 'Off'}.{' '}
            <span className="muted">When on, a payment outside a mandate, or without labels, is refused.</span>
          </div>
          {owner && <button className="btn" onClick={() => setPolicy(!s.config.require_origin)}>{s.config.require_origin ? 'Turn off' : 'Turn on'}</button>}
        </div>
      </Panel>

      <NewTask open={creating} onClose={() => setCreating(false)} />

      <Dialog open={!!closing} title="Close this mandate?" onClose={() => setClosing(null)} footer={<>
        <button className="btn" onClick={() => setClosing(null)}>Cancel</button>
        <button className="btn danger" disabled={!!b.busy} onClick={async () => { if (closing && await b.act(`Mandate ${closing.id} closed`, 'close_task', { id: closing.id })) setClosing(null); }}>
          {b.busy ? 'Waiting for confirmation…' : 'Close mandate'}
        </button>
      </>}>
        {closing && <ChangeSummary rows={[['Mandate', closing.id, 'Closed']]} signer={b.writer?.accountId ?? null} network={b.network} />}
        <p className="muted small">The agent can’t make new payments under it. Payments already sent still settle, and a held payment can only be declined.</p>
      </Dialog>

      <Dialog open={!!vouch} title={vouch?.on ? 'Vouch for this agent’s labels?' : 'Stop vouching?'} onClose={() => setVouch(null)} footer={<>
        <button className="btn" onClick={() => setVouch(null)}>Cancel</button>
        <button className={`btn ${vouch?.on ? 'primary' : 'danger'}`} disabled={!!b.busy}
          onClick={async () => { if (vouch && await b.act(vouch.on ? 'Agent vouched for' : 'Stopped vouching', 'set_label_vouch', { agent: vouch.agent, vouched: vouch.on })) setVouch(null); }}>
          {b.busy ? 'Waiting for confirmation…' : vouch?.on ? 'Vouch' : 'Stop vouching'}
        </button>
      </>}>
        {vouch && <ChangeSummary rows={[['Agent', short(vouch.agent), vouch.on ? 'Labels accepted (vouched)' : 'Labels need a TEE proof']]} signer={b.writer?.accountId ?? null} network={b.network} />}
        {vouch?.on && <p className="small">Only vouch for a runtime you control. Its labels are believed without a hardware proof. The contract still keeps every payment under a mandate to its payees, budget and limits.</p>}
      </Dialog>

      <Dialog open={policy !== null} title={policy ? 'Require origin labels?' : 'Stop requiring origin labels?'} onClose={() => setPolicy(null)} footer={<>
        <button className="btn" onClick={() => setPolicy(null)}>Cancel</button>
        <button className="btn primary" disabled={!!b.busy}
          onClick={async () => { if (policy !== null && await b.act(policy ? 'Origin labels required' : 'Origin labels optional', 'set_origin_policy', { require_origin: policy })) setPolicy(null); }}>
          {b.busy ? 'Waiting for confirmation…' : 'Confirm'}
        </button>
      </>}>
        <ChangeSummary rows={[['Every payment needs labels', s.config.require_origin ? 'Yes' : 'No', policy ? 'Yes' : 'No']]} signer={b.writer?.accountId ?? null} network={b.network} />
        {policy && <p className="muted small">Agents without mandates, or older agents that don’t send labels, won’t be able to pay until you give them a mandate.</p>}
      </Dialog>
    </>
  );
}

function NewTask({ open, onClose }: { open: boolean; onClose: () => void }) {
  const b = useBanbo();
  const s = b.state!;
  const [f, setF] = useState({ id: '', agent: s.agents[0]?.[0] ?? '', description: '', payees: '', asset: '', budget: '', max: '', sources: '', days: '7' });
  const [err, setErr] = useState('');
  const close = () => { setErr(''); onClose(); };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const id = f.id.trim();
      if (!/^[A-Za-z0-9._-]{1,64}$/.test(id)) throw new Error('Mandate id: 1–64 letters, numbers, dots, dashes or underscores.');
      if (s.tasks.some((t) => t.id === id)) throw new Error('That mandate id is already used.');
      const payees = list(f.payees);
      if (payees.length < 1 || payees.length > 10) throw new Error('Add 1–10 payees.');
      const bad = payees.find((p) => !ACCOUNT.test(p));
      if (bad) throw new Error(`“${bad}” isn’t a NEAR account id.`);
      const notAllowed = payees.filter((p) => !s.allowlist.includes(p));
      if (notAllowed.length) throw new Error(`Not on your allowlist: ${notAllowed.join(', ')}. Payees must be accounts you already allow in Spending Rules.`);
      const sources = list(f.sources.toLowerCase());
      const badSrc = sources.find((x) => !SOURCE.test(x) || x.endsWith(':unverified'));
      if (badSrc) throw new Error(`“${badSrc}” isn’t a source like email:acme.com or web:portal.acme.com.`);
      const asset = assetOf(s, f.asset || null);
      const budget = toUnits(f.budget, asset.decimals);
      const max = toUnits(f.max, asset.decimals);
      if (BigInt(budget) === 0n || BigInt(max) === 0n || BigInt(max) > BigInt(budget)) throw new Error('Max per payment must be more than 0 and no more than the budget.');
      const days = Number(f.days);
      if (!(days > 0 && days <= 365)) throw new Error('End: 1–365 days from now.');
      setErr('');
      const ok = await b.act(`Mandate ${id} created`, 'create_task', {
        id, agent: f.agent, description: f.description.trim(), payees, token: f.asset || null,
        budget, max_per_payment: max, trusted_sources: sources, expires_at_ms: Date.now() + Math.round(days * 86_400_000),
      });
      if (ok) close();
    } catch (x) { setErr((x as Error).message); }
  };
  const field = (k: keyof typeof f, label: string, hint?: string, ph = '') => (
    <label className="field">
      <span>{label}</span>
      <input value={f[k]} placeholder={ph} onChange={(e) => setF({ ...f, [k]: e.target.value })} spellCheck={false} />
      {hint && <small>{hint}</small>}
    </label>
  );
  const asset = assetOf(s, f.asset || null);
  return (
    <Dialog open={open} title="New mandate" onClose={close} footer={<>
      <button className="btn" onClick={close}>Cancel</button>
      <button className="btn primary" form="new-task" disabled={!!b.busy}>{b.busy ? 'Waiting for confirmation…' : 'Create mandate'}</button>
    </>}>
      <form id="new-task" className="form" onSubmit={submit}>
        {field('id', 'Mandate id', 'A short name, e.g. acme-october', 'acme-october')}
        <label className="field">
          <span>Agent</span>
          <select value={f.agent} onChange={(e) => setF({ ...f, agent: e.target.value })}>
            {s.agents.map(([id]) => <option key={id} value={id}>{id}</option>)}
          </select>
        </label>
        {field('description', 'What the job is', 'Shown to the agent’s planner. Write it yourself; don’t paste emails here.', 'Pay Acme’s October support invoice')}
        {field('payees', 'Who it may pay', `NEAR accounts, separated by commas, from your allowlist${s.allowlist.length ? `: ${s.allowlist.join(', ')}` : ' (add them in Spending Rules first)'}.`, s.allowlist[0] ?? 'acme.near')}
        <div className="form-row">
          <label className="field">
            <span>Asset</span>
            <select value={f.asset} onChange={(e) => setF({ ...f, asset: e.target.value })}>
              <option value="">NEAR</option>
              {s.tokens.map((t) => <option key={t.token} value={t.token}>{t.symbol}</option>)}
            </select>
          </label>
          {field('budget', `Budget (${asset.symbol})`, undefined, '100')}
          {field('max', `Max per payment`, undefined, '50')}
        </div>
        {field('sources', 'Trust amounts from', 'Senders allowed to set an amount without your review, e.g. email:acme.com. Leave empty to review every amount from a document.', 'email:acme.com')}
        {field('days', 'Ends in (days)')}
        {err && <p className="form-err" role="alert">{err}</p>}
        <p className="muted xs">The budget is a ceiling, not a transfer: whatever the agent doesn’t spend stays in the vault.</p>
      </form>
    </Dialog>
  );
}
