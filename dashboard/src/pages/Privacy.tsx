import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useBanbo } from '../state';
import { short, until, duration, ago } from '../format';
import { Panel, PageHeader, Dialog, ChangeSummary, Empty } from '../ui';
import { hiddenEntry, readLabel, type HiddenLabel, type OwnerKeys } from '../privacy';
import type { TeeMeasurement } from '../near';

type Pending = { title: string; rows: [string, ReactNode, ReactNode][]; note?: ReactNode; label: string; method: string; args: object; danger?: boolean; after?: () => void };

export default function Privacy() {
  const b = useBanbo();
  const s = b.state!;
  const c = s.config;
  const owner = b.isOwner;
  const [pending, setPending] = useState<Pending | null>(null);
  const keyMatches = !!b.keys && b.keys.publicKey === c.owner_encryption_key;

  const submit = async () => {
    if (!pending) return;
    if (await b.act(pending.label, pending.method, pending.args)) {
      pending.after?.();
      setPending(null);
    }
  };

  return (
    <>
      <PageHeader title="Privacy" subtitle="Keep your vendor list and payment notes to yourself, and only let agents spend when they run in a verified TEE." />

      <UnlockPanel keyMatches={keyMatches} />

      <Panel title="Encrypted memos">
        <div className="risk-grid">
          <div>
            <div className="label">Owner encryption key</div>
            <div className="rule-value">{c.owner_encryption_key ? <span className="mono" title={c.owner_encryption_key}>{short(c.owner_encryption_key)}</span> : 'Not set'}</div>
            <p className="rule-desc">Agents seal each memo to this key before sending it. On-chain it is unreadable; only this dashboard, unlocked by you, can open it.</p>
          </div>
          <div>
            <div className="label">Plaintext memos</div>
            <div className="rule-value">{c.encrypted_memos_only ? <span className="badge green"><span className="dot" />Refused</span> : <span className="badge gray"><span className="dot" />Allowed</span>}</div>
            <p className="rule-desc">When refused, a payment with a readable memo is rejected and the memo isn’t copied into the vault’s records.</p>
          </div>
        </div>
        {owner && (
          <div className="detail-actions">
            {!b.keys && <span className="muted small">Unlock above to turn on or change encryption.</span>}
            {b.keys && !keyMatches && (
              <button className="btn primary" onClick={() => setPending({
                title: c.owner_encryption_key ? 'Replace the encryption key?' : 'Turn on encrypted memos?',
                label: 'Encrypted memos on', method: 'set_privacy',
                args: { owner_encryption_key: b.keys!.publicKey, encrypted_memos_only: true },
                rows: [
                  ['Encryption key', c.owner_encryption_key ? short(c.owner_encryption_key) : 'None', short(b.keys!.publicKey)],
                  ['Plaintext memos', c.encrypted_memos_only ? 'Refused' : 'Allowed', 'Refused'],
                ],
                note: c.owner_encryption_key
                  ? 'Memos and hidden-vendor labels sealed to the old key will only open with the old key. Keep it if you need them.'
                  : 'Agents need the new key to keep paying: they read it from the contract, so no change on their side.',
              })}>{c.owner_encryption_key ? 'Use this device’s key' : 'Turn on encrypted memos'}</button>
            )}
            {keyMatches && (
              <button className="btn" onClick={() => setPending({
                title: c.encrypted_memos_only ? 'Allow plaintext memos?' : 'Refuse plaintext memos?',
                label: 'Memo rule updated', method: 'set_privacy',
                args: { owner_encryption_key: c.owner_encryption_key, encrypted_memos_only: !c.encrypted_memos_only },
                rows: [['Plaintext memos', c.encrypted_memos_only ? 'Refused' : 'Allowed', c.encrypted_memos_only ? 'Allowed' : 'Refused']],
                danger: c.encrypted_memos_only,
              })}>{c.encrypted_memos_only ? 'Allow plaintext memos' : 'Refuse plaintext memos'}</button>
            )}
          </div>
        )}
      </Panel>

      <HiddenPanel keyMatches={keyMatches} onReview={setPending} />
      <TeePanel onReview={setPending} />

      <Panel title="What stays public">
        <ul className="plain-list">
          <li><strong>Payments that are made.</strong> Amount, recipient, token and time of every transfer are public on NEAR, as on any public chain. A hidden vendor stops being hidden once it is paid.</li>
          <li><strong>That rules exist.</strong> Anyone can see how many hidden vendors there are, when they were added, and your spending limits.</li>
          <li><strong>The agent’s own transactions.</strong> Their arguments are public. That’s why memos are sealed by the agent runtime before they’re sent, not left to the model.</li>
          <li><strong>No zero-knowledge proofs.</strong> Privacy here comes from encryption, salted fingerprints and TEEs, not from hiding transfers.</li>
        </ul>
      </Panel>

      <Dialog open={!!pending} title={pending?.title ?? ''} onClose={() => setPending(null)}
        footer={<>
          <button className="btn" onClick={() => setPending(null)}>Cancel</button>
          <button className={`btn ${pending?.danger ? 'danger' : 'primary'}`} disabled={!!b.busy} onClick={submit}>{b.busy ? 'Waiting for confirmation…' : 'Sign and apply'}</button>
        </>}>
        {pending && <>
          <ChangeSummary rows={pending.rows} signer={b.writer?.accountId ?? null} network={b.network} />
          {pending.note && <p className="muted small">{pending.note}</p>}
        </>}
      </Dialog>
    </>
  );
}

function UnlockPanel({ keyMatches }: { keyMatches: boolean }) {
  const b = useBanbo();
  const c = b.state!.config;
  const [pass, setPass] = useState('');
  const [working, setWorking] = useState(false);
  const [err, setErr] = useState('');
  const demo = b.network === 'sandbox' ? b.sandbox?.demoPassphrase : undefined;

  const use = (k: OwnerKeys | null) => {
    if (!k) return;
    if (c.owner_encryption_key && k.publicKey !== c.owner_encryption_key) {
      setErr('That key doesn’t match the vault’s encryption key. Use the same wallet key or passphrase you turned encryption on with.');
      return;
    }
    setErr('');
    b.setKeys(k);
  };
  const fromPass = async (p: string) => {
    if (p.length < 12 && p !== demo) return setErr('Use at least 12 characters.');
    setWorking(true);
    try { use(await b.deriveWithPassphrase(p)); } finally { setWorking(false); setPass(''); }
  };

  if (b.keys) {
    return (
      <Panel title="Private mode" action={<button className="btn" onClick={() => b.setKeys(null)}>Lock</button>}>
        <p><span className="badge green"><span className="dot" />Unlocked on this device</span></p>
        <p className="muted small">Memos and hidden vendors are readable on this page until you lock it or reload. The key is kept in memory only.{!keyMatches && !c.owner_encryption_key && ' Encryption isn’t on yet; turn it on below.'}</p>
      </Panel>
    );
  }
  return (
    <Panel title="Private mode">
      <p className="muted">Unlock to read encrypted memos and hidden vendors. Your key is derived on this device and never leaves it.</p>
      <div className="unlock">
        {b.network !== 'sandbox' && (
          <div>
            <button className="btn primary" disabled={working || !b.handle || !b.writer?.accountId} onClick={async () => { setWorking(true); try { use(await b.deriveWithWallet()); } finally { setWorking(false); } }}>
              Unlock with wallet
            </button>
            <p className="muted xs">Signs a fixed message (no transaction). Use the same wallet key each time.</p>
          </div>
        )}
        <form className="inline-form" onSubmit={(e) => { e.preventDefault(); fromPass(pass); }}>
          <input type="password" value={pass} onChange={(e) => setPass(e.target.value)} placeholder="Passphrase" aria-label="Private mode passphrase" autoComplete="off" />
          <button className="btn" disabled={working || !pass}>{working ? 'Deriving…' : 'Unlock with passphrase'}</button>
        </form>
      </div>
      {demo && (
        <p className="dev-note small">Local sandbox: the demo uses the published passphrase <code>{demo}</code>. <button className="link-btn" onClick={() => fromPass(demo)}>Use it</button></p>
      )}
      {err && <div className="form-err" role="alert">{err}</div>}
    </Panel>
  );
}

function HiddenPanel({ keyMatches, onReview }: { keyMatches: boolean; onReview: (p: Pending) => void }) {
  const b = useBanbo();
  const s = b.state!;
  const [labels, setLabels] = useState<Record<string, HiddenLabel | null>>({});
  const [account, setAccount] = useState('');
  const [note, setNote] = useState('');
  const [err, setErr] = useState('');
  const [added, setAdded] = useState<{ account: string; salt: string } | null>(null);

  useEffect(() => {
    if (!b.keys) { setLabels({}); return; }
    let stop = false;
    Promise.all(s.hidden.map(async (h) => [h.fingerprint, await readLabel(h.fingerprint, h.label, b.keys!.secretKey)] as const))
      .then((pairs) => { if (!stop) setLabels(Object.fromEntries(pairs)); });
    return () => { stop = true; };
  }, [b.keys, s.hidden]);

  const config = Object.fromEntries(Object.values(labels).filter((l): l is HiddenLabel => !!l).map((l) => [l.account, l.salt]));
  const copy = (text: string) => navigator.clipboard?.writeText(text).then(() => b.toast('ok', 'Copied'), () => b.toast('err', 'Couldn’t copy'));

  // The "give your agent this entry" note goes away once that vendor is removed.
  const addedSeen = useRef(false);
  useEffect(() => {
    if (!added) { addedSeen.current = false; return; }
    if (config[added.account] === added.salt) addedSeen.current = true;
    else if (addedSeen.current) setAdded(null);
  }, [added, labels]);

  return (
    <Panel title="Hidden vendors" action={b.keys && Object.keys(config).length > 0 && (
      <button className="btn" onClick={() => copy(JSON.stringify(config, null, 2))}>Copy agent config</button>
    )}>
      <p className="muted">These vendors are stored on-chain only as salted fingerprints, so nobody can read your vendor list. Your agent gets each vendor’s salt in its runtime config (the model never sees it) and passes it when paying.</p>
      {s.hidden.length === 0 ? <p className="muted"><em>No hidden vendors yet.</em></p> : (
        <ul className="list">
          {s.hidden.map((h) => {
            const l = labels[h.fingerprint];
            const cooling = h.payable_from_ms > b.now;
            return (
              <li key={h.fingerprint}>
                <span className="rcpt spaced">
                  {l ? <span className="mono">{l.account}</span> : <span className="mono muted" title={h.fingerprint}>{h.fingerprint.slice(0, 16)}…</span>}
                  {l?.note && <span className="muted small">{l.note}</span>}
                  {!b.keys && <span className="badge gray inline"><span className="dot" />Locked</span>}
                  {b.keys && l === null && <span className="badge amber inline" title="The label didn’t open with your key, or doesn’t match this fingerprint."><span className="dot" />Unknown</span>}
                  {cooling && <span className="badge amber inline"><span className="dot" />Cooldown · payable {until(h.payable_from_ms, b.now)}</span>}
                  <span className="muted xs">added {ago(h.added_at_ms, b.now)}</span>
                </span>
                {b.isOwner && <button className="btn sm ghost" onClick={() => onReview({
                  title: 'Remove hidden vendor?', label: 'Hidden vendor removed', method: 'disallow_hidden_recipient', args: { fingerprint: h.fingerprint }, danger: true,
                  rows: [['Vendor', l ? l.account : `${h.fingerprint.slice(0, 16)}…`, 'Removed']],
                  note: 'Agents will no longer be able to pay it. Payments to it that are waiting for approval can’t be approved.',
                })}>Remove</button>}
              </li>
            );
          })}
        </ul>
      )}
      {b.isOwner && (keyMatches ? (
        <form className="inline-form wide" onSubmit={async (e) => {
          e.preventDefault();
          const a = account.trim();
          if (!/^[a-z0-9._-]{2,64}$/.test(a)) return setErr('Enter a valid NEAR account id.');
          if (config[a]) return setErr('Already a hidden vendor.');
          setErr('');
          const entry = await hiddenEntry(a, b.keys!.publicKey, note.trim().slice(0, 80));
          onReview({
            title: 'Add hidden vendor?', label: 'Hidden vendor added', method: 'allow_hidden_recipient',
            args: { fingerprint: entry.fingerprint, label: entry.label },
            rows: [['Vendor', <span className="mono">{a}</span>, 'Allowed, hidden']],
            note: <>On-chain this appears only as <span className="mono">{entry.fingerprint.slice(0, 16)}…</span>. After it’s added, copy the agent config so your agent can pay it.</>,
            after: () => { setAccount(''); setNote(''); setAdded({ account: a, salt: entry.salt }); },
          });
        }}>
          <input value={account} onChange={(e) => setAccount(e.target.value)} placeholder="vendor.near" aria-label="Hidden vendor account" spellCheck={false} />
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional, encrypted)" aria-label="Note" />
          <button className="btn">Add hidden vendor</button>
        </form>
      ) : <p className="muted small">{b.keys ? 'Turn on encrypted memos with this device’s key to add hidden vendors.' : 'Unlock private mode to add hidden vendors.'}</p>)}
      {err && <div className="form-err" role="alert">{err}</div>}
      {added && (
        <div className="note">
          <p className="small"><strong>Give your agent this entry.</strong> You can copy it again later from this page.</p>
          <pre>{JSON.stringify({ [added.account]: added.salt }, null, 2)}</pre>
          <button className="btn sm" onClick={() => copy(JSON.stringify({ [added.account]: added.salt }))}>Copy</button>
        </div>
      )}
    </Panel>
  );
}

function TeePanel({ onReview }: { onReview: (p: Pending) => void }) {
  const b = useBanbo();
  const s = b.state!;
  const t = s.tee;
  const [editPolicy, setEditPolicy] = useState(false);
  const [addM, setAddM] = useState(false);

  const status = (agent: string) => {
    const info = s.agentTee[agent];
    if (!info) return { tone: 'gray', text: 'Not attested' };
    if (info.valid_until_ms <= b.now) return { tone: 'amber', text: 'Attestation expired' };
    if (!t.measurements.some(([id]) => id === info.measurement_id)) return { tone: 'amber', text: 'Image no longer approved' };
    return { tone: 'green', text: `Verified · ${until(info.valid_until_ms, b.now).replace(/^in /, '')} left` };
  };

  return (
    <Panel title="TEE agents" action={b.isOwner && <button className="btn" onClick={() => setEditPolicy(true)}>Change</button>}>
      <p className="muted">A private agent runs inside an Intel TDX confidential VM, where nobody, not even the host, can read its keys, prompts or memos. It proves this with a hardware-signed quote that the vault contract verifies itself, including that the VM runs exactly the image you approved.</p>
      <div className="risk-grid">
        <div>
          <div className="label">Require TEE agents</div>
          <div className="rule-value">{t.require_tee ? <span className="badge green"><span className="dot" />On</span> : <span className="badge gray"><span className="dot" />Off</span>}</div>
          <p className="rule-desc">When on, only agents with a valid attestation can spend. Others are rejected.</p>
        </div>
        <div>
          <div className="label">Attestation lasts</div>
          <div className="rule-value">{duration(t.attestation_ttl_ms)}</div>
          <p className="rule-desc">Agents re-attest before it runs out. TCB status accepted: UpToDate{t.allow_sw_hardening_needed ? ' or SWHardeningNeeded' : ' only'}.{t.ppids.length ? ` Pinned to ${t.ppids.length} CPU${t.ppids.length > 1 ? 's' : ''}.` : ''}</p>
        </div>
      </div>

      <h3 className="sub">Approved images</h3>
      {t.measurements.length === 0 ? <p className="muted"><em>None. No agent can attest until you approve the image it runs.</em></p> : (
        <ul className="list">
          {t.measurements.map(([id, m]) => (
            <li key={id}>
              <span className="rcpt">
                <span className="mono" title={`compose ${m.compose_hash}`}>app {m.compose_hash.slice(0, 16)}…</span>
                <span className="muted xs mono" title={m.mrtd}>id {id.slice(0, 12)}</span>
              </span>
              {b.isOwner && <button className="btn sm ghost" onClick={() => onReview({
                title: 'Remove approved image?', label: 'Image removed', method: 'remove_tee_measurement', args: { id }, danger: true,
                rows: [['App', `${m.compose_hash.slice(0, 16)}…`, 'Not approved']],
                note: 'Agents attested with this image stop being able to spend right away.',
              })}>Remove</button>}
            </li>
          ))}
        </ul>
      )}
      {b.isOwner && <button className="btn sm" onClick={() => setAddM(true)}>Approve an image</button>}

      <h3 className="sub">Agents</h3>
      {s.agents.length === 0 ? <Empty title="No agents registered" /> : (
        <div className="table-wrap">
          <table className="table stack">
            <thead><tr><th>Agent</th><th>Attestation</th><th>App</th><th>TCB</th></tr></thead>
            <tbody>
              {s.agents.map(([id]) => {
                const info = s.agentTee[id];
                const st = status(id);
                return (
                  <tr key={id}>
                    <td><span className="mono" title={id}>{short(id)}</span></td>
                    <td data-label="Attestation"><span className={`badge ${st.tone}`}><span className="dot" />{st.text}</span></td>
                    <td data-label="App" className="mono">{info ? `${info.compose_hash.slice(0, 12)}…` : '-'}</td>
                    <td data-label="TCB">{info?.tcb_status ?? '-'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {editPolicy && <TeePolicyDialog onClose={() => setEditPolicy(false)} onReview={(p) => { setEditPolicy(false); onReview(p); }} />}
      {addM && <MeasurementDialog onClose={() => setAddM(false)} onReview={(p) => { setAddM(false); onReview(p); }} />}
    </Panel>
  );
}

function TeePolicyDialog({ onClose, onReview }: { onClose: () => void; onReview: (p: Pending) => void }) {
  const t = useBanbo().state!.tee;
  const [req, setReq] = useState(t.require_tee);
  const [days, setDays] = useState(String(t.attestation_ttl_ms / 86_400_000));
  const [sw, setSw] = useState(t.allow_sw_hardening_needed);
  const [err, setErr] = useState('');
  return (
    <Dialog open title="TEE agents" onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" form="tee-form">Review</button></>}>
      <form id="tee-form" className="form" onSubmit={(e) => {
        e.preventDefault();
        const d = Number(days);
        if (!Number.isFinite(d) || d < 0.01 || d > 90) return setErr('Attestation must last between 15 minutes and 90 days.');
        const ms = Math.round(d * 86_400_000);
        onReview({
          title: 'Review change', label: 'TEE settings updated', method: 'set_tee_policy',
          args: { require_tee: req, attestation_ttl_ms: ms, allow_sw_hardening_needed: sw },
          rows: [
            ['Require TEE agents', t.require_tee ? 'On' : 'Off', req ? 'On' : 'Off'],
            ['Attestation lasts', duration(t.attestation_ttl_ms), duration(ms)],
            ['Accept SWHardeningNeeded', t.allow_sw_hardening_needed ? 'Yes' : 'No', sw ? 'Yes' : 'No'],
          ],
          note: req && !t.require_tee ? 'Agents without a valid attestation will be rejected from now on.' : undefined,
        });
      }}>
        <label className="check"><input type="checkbox" checked={req} onChange={(e) => setReq(e.target.checked)} /> Only attested agents can spend</label>
        <label className="field"><span>Attestation lasts (days)</span><input value={days} onChange={(e) => setDays(e.target.value)} inputMode="decimal" /></label>
        <label className="check"><input type="checkbox" checked={sw} onChange={(e) => setSw(e.target.checked)} /> Also accept TCB status SWHardeningNeeded (hardware is genuine; Intel recommends extra software mitigations)</label>
        {err && <div className="form-err" role="alert">{err}</div>}
      </form>
    </Dialog>
  );
}

const HEX = (n: number) => new RegExp(`^(0x)?[0-9a-fA-F]{${n * 2}}$`);

function MeasurementDialog({ onClose, onReview }: { onClose: () => void; onReview: (p: Pending) => void }) {
  const [text, setText] = useState('');
  const [err, setErr] = useState('');
  return (
    <Dialog open title="Approve an agent image" onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" form="m-form">Review</button></>}>
      <form id="m-form" className="form" onSubmit={(e) => {
        e.preventDefault();
        let m: TeeMeasurement;
        try {
          const j = JSON.parse(text);
          m = { mrtd: j.mrtd, rtmr0: j.rtmr0, rtmr1: j.rtmr1, rtmr2: j.rtmr2, compose_hash: j.compose_hash, key_provider_digest: j.key_provider_digest ?? null };
        } catch { return setErr('Paste the measurement JSON printed by the TEE agent.'); }
        for (const k of ['mrtd', 'rtmr0', 'rtmr1', 'rtmr2'] as const) if (!HEX(48).test(m[k] ?? '')) return setErr(`${k} must be 48 bytes of hex.`);
        if (!HEX(32).test(m.compose_hash ?? '')) return setErr('compose_hash must be 32 bytes of hex.');
        if (m.key_provider_digest && !HEX(48).test(m.key_provider_digest)) return setErr('key_provider_digest must be 48 bytes of hex.');
        onReview({
          title: 'Approve this image?', label: 'Image approved', method: 'approve_tee_measurement', args: { measurement: m },
          rows: [['App (compose hash)', 'Not approved', `${m.compose_hash.replace(/^0x/, '').slice(0, 16)}…`], ['Firmware (MRTD)', '', `${m.mrtd.replace(/^0x/, '').slice(0, 16)}…`]],
          note: 'Any VM running exactly this image can attest as one of your registered agents. Check the compose hash against the published agent build before approving.',
        });
      }}>
        <p className="muted small">The TEE agent prints this at startup and serves it at <code>/attestation</code>. Its compose hash should match the build in the Banbo repository.</p>
        <label className="field"><span>Measurement JSON</span>
          <textarea rows={8} value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} placeholder={'{\n  "mrtd": "…",\n  "rtmr0": "…",\n  "rtmr1": "…",\n  "rtmr2": "…",\n  "compose_hash": "…"\n}'} />
        </label>
        {err && <div className="form-err" role="alert">{err}</div>}
      </form>
    </Dialog>
  );
}
