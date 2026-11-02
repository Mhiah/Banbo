import { useMemo, useState, type ReactNode } from 'react';
import { open as openSealed, isSealed } from '../privacy';
import { useBanbo } from '../state';
import { activity, STATUS, type ActivityItem, type Kind } from '../activity';
import { near, ago, until, duration, reasonText, short, originText } from '../format';
import { Panel, PageHeader, StatusBadge, Addr, Amount, Empty, Drawer, Dialog } from '../ui';
import type { PaymentRequest } from '../near';

const FILTERS: { key: 'all' | 'open' | Kind; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'blocked', label: 'Blocked' },
  { key: 'Settled', label: 'Paid' },
  { key: 'open', label: 'Open' },
  { key: 'Failed', label: 'Failed' },
  { key: 'Declined', label: 'Declined' },
  { key: 'Expired', label: 'Expired' },
];

const POLICY: Record<string, string> = {
  recipient_not_allowlisted: 'Allowed recipients',
  exceeds_per_request_max: 'Max per payment',
  exceeds_agent_period_limit: 'Agent daily limit',
  exceeds_shared_cap: 'Shared daily limit',
  insufficient_vault_balance: 'Vault balance',
  agent_disabled: 'Agent status',
  vault_paused: 'Emergency pause',
  recipient_not_allowed: 'Self-payment guard',
  zero_amount: 'Amount check',
  token_not_supported: 'Accepted tokens',
  token_not_enabled_for_agent: 'Agent token limits',
  recipient_in_cooldown: 'New recipient cooldown',
  exceeds_payment_rate: 'Payments per hour',
  memo_not_encrypted: 'Encrypted memos only',
  agent_not_attested: 'TEE agents only',
  attestation_expired: 'TEE attestation lifetime',
  agent_measurement_not_approved: 'Approved agent images',
  too_many_open_payments: 'Open payments limit',
  origin_required: 'Origin labels required',
  task_not_found: 'Mandate',
  task_not_for_agent: 'Mandate',
  task_closed: 'Mandate',
  task_expired: 'Mandate end time',
  task_token_mismatch: 'Mandate asset',
  recipient_from_untrusted_source: 'Origin check: recipient must come from you',
  recipient_not_in_task: 'Mandate payees',
  exceeds_task_max_per_payment: 'Mandate max per payment',
  exceeds_task_budget: 'Mandate budget',
};

const LONG_REASON: Record<string, string> = {
  recipient_not_allowlisted: 'This payment was rejected because the recipient isn’t on the vault’s list of allowed recipients.',
  exceeds_per_request_max: 'This payment was rejected because it’s larger than this agent’s maximum per payment.',
  exceeds_agent_period_limit: 'This payment was rejected because it would take this agent over its daily limit.',
  exceeds_shared_cap: 'This payment was rejected because it would exceed the shared daily spending limit.',
  insufficient_vault_balance: 'This payment was rejected because the vault doesn’t have enough spendable funds.',
  agent_disabled: 'This payment was rejected because the agent is disabled.',
  vault_paused: 'This payment was rejected because all payments are paused.',
  recipient_not_allowed: 'This payment was rejected because an agent can’t pay itself or the vault.',
  token_not_supported: 'This payment was rejected because the vault doesn’t accept this token.',
  token_not_enabled_for_agent: 'This payment was rejected because this agent has no spending limits for this token.',
  recipient_not_registered: 'This payment didn’t go out because the recipient isn’t registered with the token contract, so it couldn’t receive the tokens. The reservation was released and nothing left the vault.',
  transfer_failed: 'The transfer failed on-chain. The reservation was released exactly once and the funds stayed in the vault.',
  recipient_in_cooldown: 'This payment was rejected because the recipient was allowed only recently and its cooldown hasn’t passed. The cooldown gives you time to check new recipients before money can reach them.',
  exceeds_payment_rate: 'This payment was rejected because the agent hit its limit on payments per hour. This stops many small payments from adding up.',
  memo_not_encrypted: 'This payment was rejected because its memo wasn’t encrypted to your key. The memo was not stored by the vault.',
  agent_not_attested: 'This payment was rejected because the vault only pays for agents that proved they run your approved image inside a TEE, and this agent hasn’t.',
  attestation_expired: 'This payment was rejected because the agent’s TEE attestation has expired. It needs to attest again.',
  agent_measurement_not_approved: 'This payment was rejected because the agent attested with an image you’ve since removed from the approved list.',
  too_many_open_payments: 'This payment was rejected because too many payments were already waiting for approval or for their transfer result (the vault allows 100 at once).',
  reconciled_by_owner: 'The transfer’s result never came back, so you marked it as not sent. The reservation was released and, for a token, the amount was put back in the vault’s balance.',
  recipient_from_untrusted_source: 'Refused: the agent took this recipient from a document (an email, page or file) instead of from you. Under a task mandate, only you decide who gets paid, so a forged “we changed banks” message can’t redirect money.',
  recipient_not_in_task: 'Refused: this recipient isn’t one of the payees you set in the mandate, even though it may be an approved vendor.',
  exceeds_task_max_per_payment: 'Refused: larger than the mandate’s maximum per payment.',
  exceeds_task_budget: 'Refused: this would take the mandate over its budget.',
  task_closed: 'Refused: the mandate was closed.',
  task_expired: 'Refused: the mandate’s end time has passed.',
  task_not_for_agent: 'Refused: the mandate belongs to a different agent.',
  task_not_found: 'Refused: the payment named a mandate that doesn’t exist.',
  task_token_mismatch: 'Refused: the mandate is for a different asset.',
  origin_required: 'Refused: the vault requires origin labels on every payment, and this one had none.',
};

const Lock = () => (
  <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden><rect x="2" y="5.5" width="8" height="5.5" rx="1" fill="none" stroke="currentColor" strokeWidth="1.3" /><path d="M4 5.5V4a2 2 0 0 1 4 0v1.5" fill="none" stroke="currentColor" strokeWidth="1.3" /></svg>
);

/** A memo as the owner should see it: opened if sealed and unlocked. */
function Memo({ memo, text }: { memo: string; text: string | null }): ReactNode {
  if (!isSealed(memo)) return memo;
  if (text !== null) return <span className="memo-lock" title="Encrypted on-chain; opened on this device"><Lock />{text}</span>;
  return <span className="memo-lock muted" title="Unlock private mode on the Privacy page to read it"><Lock />Encrypted memo</span>;
}

export default function Activity() {
  const b = useBanbo();
  const s = b.state!;
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<(typeof FILTERS)[number]['key']>('all');
  const [open, setOpen] = useState<ActivityItem | null>(null);

  const all = useMemo(() => activity(s), [s]);
  const opened = useMemo(() => {
    const m = new Map<string, string | null>();
    for (const i of all) if (isSealed(i.memo)) m.set(i.memo, b.keys ? openSealed(i.memo, b.keys.secretKey) : null);
    return m;
  }, [all, b.keys]);
  const memoText = (i: ActivityItem) => (isSealed(i.memo) ? opened.get(i.memo) ?? '' : i.memo);
  const shown = all.filter((i) => {
    if (filter === 'open' && !(i.kind === 'InFlight' || i.kind === 'PendingApproval')) return false;
    if (filter !== 'all' && filter !== 'open' && i.kind !== filter) return false;
    if (!q.trim()) return true;
    const t = q.trim().toLowerCase();
    return [i.agent, i.recipient, memoText(i), i.requestId, i.reason ?? '', i.asset.symbol].some((f) => f.toLowerCase().includes(t));
  });
  const count = (k: Kind) => all.filter((i) => i.kind === k).length;

  return (
    <>
      <PageHeader title="Activity" subtitle="Every payment your agents requested, and every attempt the contract blocked." />
      <div className="toolbar">
        <div className="filters" role="tablist" aria-label="Filter by status">
          {FILTERS.map((f) => (
            <button key={f.key} role="tab" aria-selected={filter === f.key} className={filter === f.key ? 'on' : ''} onClick={() => setFilter(f.key)}>
              {f.label}
              {f.key !== 'all' && f.key !== 'open' && count(f.key as Kind) > 0 && <span className="fcount">{count(f.key as Kind)}</span>}
            </button>
          ))}
        </div>
        <input className="search" type="search" placeholder="Search agent, recipient or memo" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search activity" />
      </div>

      <Panel flush>
        {shown.length === 0 ? (
          <Empty title={all.length ? 'No matching activity' : 'No activity yet'}>{all.length ? <p>Try another filter or search.</p> : <p>Payment requests from your agents will appear here.</p>}</Empty>
        ) : (
          <div className="table-wrap">
            <table className="table hover feed">
              <thead><tr><th>Time</th><th>Agent</th><th>Recipient</th><th className="r">Amount</th><th>Status</th><th className="hide-sm">Details</th></tr></thead>
              <tbody>
                {shown.map((i) => (
                  <tr key={i.id} tabIndex={0} onClick={() => setOpen(i)} onKeyDown={(e) => e.key === 'Enter' && setOpen(i)} className={i.kind === 'blocked' ? 'row-blocked' : ''}>
                    <td className="nowrap muted c-time" title={new Date(i.at).toLocaleString()}>{ago(i.at, b.now)}</td>
                    <td className="c-agent"><span className="mono">{short(i.agent)}</span></td>
                    <td className="c-rcpt"><span className="mono">{short(i.recipient)}</span>{i.hidden && <span className="badge gray inline" title="On your hidden vendor list">Hidden</span>}</td>
                    <td className="r num c-amt"><Amount yocto={i.amount} asset={i.asset} /></td>
                    <td className="c-status"><StatusBadge kind={i.kind} /></td>
                    <td className="details-cell c-details">{i.reason ? <span className="reason">{reasonText(i.reason)}</span> : <span className="muted"><Memo memo={i.memo} text={opened.get(i.memo) ?? null} /></span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      <p className="footnote">Blocked attempts: the contract keeps the latest 50 from registered agents ({s.blockedCount} blocked in total). It keeps the latest {s.config.history_limit.toLocaleString()} payment requests, plus any that are still open.</p>

      <Drawer open={!!open} title="Payment details" onClose={() => setOpen(null)}>
        {open && <Detail item={open} memo={<Memo memo={open.memo} text={opened.get(open.memo) ?? null} />} />}
      </Drawer>
    </>
  );
}

function Detail({ item, memo }: { item: ActivityItem; memo: ReactNode }) {
  const b = useBanbo();
  const st = STATUS[item.kind];
  const req = item.kind === 'blocked' ? null : (item.raw as PaymentRequest);
  return (
    <>
      <div className="detail-amount"><Amount yocto={item.amount} asset={item.asset} strong /></div>
      <div className="detail-status"><StatusBadge kind={item.kind} /></div>
      <p className={`detail-explain ${item.kind === 'blocked' ? 'red' : ''}`}>
        {item.reason ? (LONG_REASON[item.reason] ?? reasonText(item.reason))
          : item.kind === 'PendingApproval' && item.holdReason === 'amount_from_untrusted_source'
            ? `Held: the agent read this amount in ${originText(item.origin?.amount)}, which you haven’t marked as trusted for this mandate. Check that message before you approve.`
            : item.kind === 'PendingApproval' && item.holdReason === 'over_approval_threshold'
              ? 'Over the agent’s approval threshold. Funds are reserved until you approve or decline.'
              : st.help}
      </p>
      {item.origin && <OriginBox item={item} />}
      <dl className="kv">
        <dt>Agent</dt><dd><Addr id={item.agent} explorer={b.explorer} full /></dd>
        <dt>Recipient</dt><dd><Addr id={item.recipient} explorer={b.explorer} full />{item.hidden && <span className="badge gray inline">Hidden vendor</span>}</dd>
        <dt>Requested</dt><dd>{new Date(item.at).toLocaleString()}</dd>
        <dt>Request ID</dt><dd className="mono">{item.requestId}</dd>
        {item.asset.token && <><dt>Token</dt><dd><Addr id={item.asset.token} explorer={b.explorer} full /></dd></>}
        {item.reason && item.kind === 'blocked' && <><dt>Rule applied</dt><dd>{POLICY[item.reason] ?? item.reason}</dd></>}
        {item.reason && item.kind === 'Failed' && <><dt>Why it failed</dt><dd>{reasonText(item.reason)}</dd></>}
        {item.memo && <><dt>Memo</dt><dd>{memo}</dd></>}
        {item.kind === 'PendingApproval' && req?.expires_at_ms && <><dt>Approve by</dt><dd>{new Date(req.expires_at_ms).toLocaleString()} ({req.expires_at_ms > b.now ? until(req.expires_at_ms, b.now) : 'passed'})</dd></>}
        {item.kind !== 'blocked' && <><dt>Funds</dt><dd>{item.kind === 'Settled' ? 'Left the vault' : item.kind === 'InFlight' ? 'Reserved, transfer pending' : item.kind === 'PendingApproval' ? 'Reserved, waiting for you' : 'Returned to the vault'}</dd></>}
      </dl>
      {item.kind === 'InFlight' && req && <StuckPayment req={req} />}
      {b.explorer && (
        <p className="small"><a className="link" href={`${b.explorer}/address/${item.agent}`} target="_blank" rel="noreferrer">Find this transaction on NearBlocks ↗</a></p>
      )}
      <details className="tech">
        <summary>Technical details</summary>
        <p className="muted xs">Raw record from the contract ({item.kind === 'blocked' ? 'list_blocked' : 'get_request'}). Amounts are in yoctoNEAR (10⁻²⁴ NEAR).</p>
        <pre>{JSON.stringify(item.raw, null, 2)}</pre>
      </details>
    </>
  );
}

/** Where the recipient and the amount came from, as the contract recorded it. */
function OriginBox({ item }: { item: ActivityItem }) {
  const o = item.origin!;
  const row = (label: string, v: typeof o.recipient) => (
    <>
      <dt>{label}</dt>
      <dd>
        <span className={`badge inline ${v.kind === 'owner' ? 'green' : 'amber'}`}>{v.kind === 'owner' ? 'From you' : 'From a document'}</span>{' '}
        {v.kind === 'owner' ? 'your request, not a document' : originText(v)}
        {v.kind === 'source' && <div className="mono xs muted" title="sha256 of the exact message the agent read">sha256 {v.digest}</div>}
      </dd>
    </>
  );
  return (
    <div className="origin-box">
      <div className="origin-title">Where this payment came from</div>
      <dl className="kv">
        <dt>Mandate</dt><dd className="mono"><a className="link" href="#/tasks">{o.task_id}</a></dd>
        {row('Recipient', o.recipient)}
        {row('Amount', o.amount)}
        {item.labelTrust && <><dt>Labels from</dt><dd>{item.labelTrust === 'tee' ? 'A verified TEE agent (Intel TDX, checked on-chain)' : 'An agent you vouch for (no TEE proof)'}</dd></>}
      </dl>
    </div>
  );
}

/** A payment whose transfer result hasn't come back. Normally that takes a
 *  few seconds; after the contract's recovery window the owner can record
 *  what the explorer shows. */
function StuckPayment({ req }: { req: PaymentRequest }) {
  const b = useBanbo();
  const [choice, setChoice] = useState<null | boolean>(null);
  const since = req.dispatched_at_ms ?? req.created_at_ms;
  const recoverAt = since + b.state!.config.in_flight_recovery_ms;
  if (b.now < recoverAt) {
    return b.now - since > 60_000
      ? <p className="muted small">Still waiting for the transfer result. If it hasn’t arrived by {new Date(recoverAt).toLocaleTimeString()}, you’ll be able to settle it by hand here.</p>
      : null;
  }
  return (
    <div className="stuck">
      <p className="small"><strong>The transfer result never came back.</strong> This is rare (the vault’s callback can run out of gas, for example). Check the recipient on the explorer, then record what happened. A late result after this is refused, so the payment still counts exactly once.</p>
      {b.isOwner ? (
        <div className="detail-actions">
          <button className="btn" disabled={!!b.busy} onClick={() => setChoice(false)}>It wasn’t sent</button>
          <button className="btn primary" disabled={!!b.busy} onClick={() => setChoice(true)}>It went through</button>
        </div>
      ) : <p className="muted small">Only the vault owner can do this.</p>}
      <Dialog
        open={choice !== null}
        title={choice ? 'Mark as paid?' : 'Mark as not sent?'}
        onClose={() => setChoice(null)}
        footer={<>
          <button className="btn" onClick={() => setChoice(null)}>Cancel</button>
          <button className="btn primary" disabled={!!b.busy}
            onClick={async () => { if (await b.act(choice ? 'Payment marked as paid' : 'Payment marked as not sent', 'reconcile_stuck', { key: req.key, transferred: choice })) setChoice(null); }}>
            {b.busy ? 'Waiting for confirmation…' : 'Confirm'}
          </button>
        </>}
      >
        <p className="small">{choice
          ? 'The amount moves from reserved to spent, as if the result had arrived.'
          : 'The reservation is released and the amount counts as still in the vault. Only choose this if the recipient did not receive it.'}</p>
        <p className="muted xs">Recovery opens {duration(b.state!.config.in_flight_recovery_ms)} after sending.</p>
      </Dialog>
    </div>
  );
}
