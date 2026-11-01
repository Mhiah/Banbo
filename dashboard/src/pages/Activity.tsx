import { useMemo, useState } from 'react';
import { useBanbo } from '../state';
import { activity, STATUS, type ActivityItem, type Kind } from '../activity';
import { near, ago, reasonText, short } from '../format';
import { Panel, PageHeader, StatusBadge, Addr, Amount, Empty, Drawer } from '../ui';

const FILTERS: { key: 'all' | 'open' | Kind; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'blocked', label: 'Blocked' },
  { key: 'Settled', label: 'Paid' },
  { key: 'open', label: 'Open' },
  { key: 'Failed', label: 'Failed' },
  { key: 'Declined', label: 'Declined' },
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
};

export default function Activity() {
  const b = useBanbo();
  const s = b.state!;
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<(typeof FILTERS)[number]['key']>('all');
  const [open, setOpen] = useState<ActivityItem | null>(null);

  const all = useMemo(() => activity(s), [s]);
  const shown = all.filter((i) => {
    if (filter === 'open' && !(i.kind === 'InFlight' || i.kind === 'PendingApproval')) return false;
    if (filter !== 'all' && filter !== 'open' && i.kind !== filter) return false;
    if (!q.trim()) return true;
    const t = q.trim().toLowerCase();
    return [i.agent, i.recipient, i.memo, i.requestId, i.reason ?? '', i.asset.symbol].some((f) => f.toLowerCase().includes(t));
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
                    <td className="c-rcpt"><span className="mono">{short(i.recipient)}</span></td>
                    <td className="r num c-amt"><Amount yocto={i.amount} asset={i.asset} /></td>
                    <td className="c-status"><StatusBadge kind={i.kind} /></td>
                    <td className="details-cell c-details">{i.reason ? <span className="reason">{reasonText(i.reason)}</span> : <span className="muted">{i.memo}</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      <p className="footnote">Blocked attempts: the contract keeps the latest 50 from registered agents ({s.blockedCount} blocked in total). Payment requests are kept in full.</p>

      <Drawer open={!!open} title="Payment details" onClose={() => setOpen(null)}>
        {open && <Detail item={open} />}
      </Drawer>
    </>
  );
}

function Detail({ item }: { item: ActivityItem }) {
  const b = useBanbo();
  const st = STATUS[item.kind];
  return (
    <>
      <div className="detail-amount"><Amount yocto={item.amount} asset={item.asset} strong /></div>
      <div className="detail-status"><StatusBadge kind={item.kind} /></div>
      <p className={`detail-explain ${item.kind === 'blocked' ? 'red' : ''}`}>
        {item.reason ? (LONG_REASON[item.reason] ?? reasonText(item.reason)) : st.help}
      </p>
      <dl className="kv">
        <dt>Agent</dt><dd><Addr id={item.agent} explorer={b.explorer} full /></dd>
        <dt>Recipient</dt><dd><Addr id={item.recipient} explorer={b.explorer} full /></dd>
        <dt>Requested</dt><dd>{new Date(item.at).toLocaleString()}</dd>
        <dt>Request ID</dt><dd className="mono">{item.requestId}</dd>
        {item.asset.token && <><dt>Token</dt><dd><Addr id={item.asset.token} explorer={b.explorer} full /></dd></>}
        {item.reason && item.kind === 'blocked' && <><dt>Rule applied</dt><dd>{POLICY[item.reason] ?? item.reason}</dd></>}
        {item.reason && item.kind === 'Failed' && <><dt>Why it failed</dt><dd>{reasonText(item.reason)}</dd></>}
        {item.memo && <><dt>Memo</dt><dd>{item.memo}</dd></>}
        {item.kind !== 'blocked' && <><dt>Funds</dt><dd>{item.kind === 'Settled' ? 'Left the vault' : item.kind === 'InFlight' ? 'Reserved, transfer pending' : item.kind === 'PendingApproval' ? 'Reserved, waiting for you' : 'Returned to the vault'}</dd></>}
      </dl>
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
