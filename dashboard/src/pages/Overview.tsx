import { useBanbo } from '../state';
import { activity, STATUS } from '../activity';
import { near, units, ago, until, reasonText, short } from '../format';
import { assetOf } from '../near';
import { open as openSealed, isSealed } from '../privacy';
import { Panel, PageHeader, StatusBadge, Addr, Amount, BudgetBar, MiniBar, Empty } from '../ui';

export default function Overview() {
  const b = useBanbo();
  const s = b.state!;
  const bal = s.balances;
  const pending = s.requests.filter((r) => r.status === 'PendingApproval');
  const recent = activity(s).slice(0, 8);
  const blockedToday = s.blocked.filter((x) => b.now - x.at_ms < 86_400_000).length;
  const canAct = b.isOwner && !b.busy;

  return (
    <>
      <PageHeader title="Overview" subtitle="Manage your treasury and monitor how your agents spend." />

      <Panel>
        <div className="treasury">
          <div className="treasury-main">
            <div className="label">Vault balance</div>
            <div className="big"><Amount yocto={bal.vault_balance} strong /></div>
            <div className="sub">
              <Amount yocto={bal.available} /> available to agents
              <span className="sep">·</span>
              <span className="muted">{near(bal.operating_reserve)} kept for storage and gas</span>
            </div>
          </div>
          <div className="treasury-budget">
            <div className="label-row">
              <span className="label">Shared daily limit</span>
              <span className="num"><Amount yocto={(BigInt(bal.shared_spent) + BigInt(bal.shared_reserved)).toString()} /> of {near(bal.shared_cap)}</span>
            </div>
            <BudgetBar spent={bal.shared_spent} reserved={bal.shared_reserved} cap={bal.shared_cap} />
          </div>
        </div>
        <div className="treasury-foot">
          <div><span className="label">Being sent</span><Amount yocto={bal.in_flight} /></div>
          <div><span className="label">Held for approval</span><Amount yocto={bal.pending_approval} /></div>
          <div><span className="label">Blocked in last 24h</span><span className={`num ${blockedToday ? 'red' : ''}`}>{blockedToday}</span></div>
          <div><span className="label">Blocked all time</span><span className="num">{s.blockedCount}</span></div>
        </div>
        {s.tokens.map((t) => {
          const asset = assetOf(s, t.token);
          return (
            <div className="treasury token" key={t.token}>
              <div className="treasury-main">
                <div className="label">{t.symbol} balance</div>
                <div className="mid"><Amount yocto={t.balance} asset={asset} strong /></div>
                <div className="sub">
                  <Amount yocto={t.available} asset={asset} /> available to agents
                  {BigInt(t.in_flight) > 0n && <><span className="sep">·</span><Amount yocto={t.in_flight} asset={asset} /> being sent</>}
                  {BigInt(t.pending_approval) > 0n && <><span className="sep">·</span><Amount yocto={t.pending_approval} asset={asset} /> held for approval</>}
                </div>
              </div>
              <div className="treasury-budget">
                <div className="label-row">
                  <span className="label">{t.symbol} shared daily limit</span>
                  <span className="num"><Amount yocto={(BigInt(t.shared_spent) + BigInt(t.shared_reserved)).toString()} asset={asset} /> of {units(t.shared_cap, t.decimals)}</span>
                </div>
                <BudgetBar spent={t.shared_spent} reserved={t.shared_reserved} cap={t.shared_cap} asset={asset} />
              </div>
            </div>
          );
        })}
      </Panel>

      {pending.length > 0 && (
        <Panel title={<>Needs your approval <span className="count amber">{pending.length}</span></>}>
          <ul className="approvals">
            {pending.map((r) => (
              <li key={r.key}>
                <div className="ap-amount"><Amount yocto={r.amount} asset={assetOf(s, r.token)} strong /></div>
                <div className="ap-main">
                  <div><span className="mono">{short(r.agent)}</span> wants to pay <Addr id={r.recipient} explorer={b.explorer} /></div>
                  <div className="muted small">{r.memo ? (isSealed(r.memo) ? (b.keys && openSealed(r.memo, b.keys.secretKey) ? `“${openSealed(r.memo, b.keys.secretKey)}” · ` : 'Encrypted memo · ') : `“${r.memo}” · `) : ''}requested {ago(r.created_at_ms, b.now)} · above this agent’s approval threshold
                    {r.expires_at_ms && (r.expires_at_ms > b.now
                      ? <> · expires {until(r.expires_at_ms, b.now)}</>
                      : <> · <span className="reason">approval window passed</span></>)}
                  </div>
                </div>
                {r.expires_at_ms && r.expires_at_ms <= b.now ? (
                  <div className="ap-actions">
                    <button className="btn" disabled={!b.writer || !!b.busy} onClick={() => b.act('Expired approvals released', 'expire_pending', {})} title="Nobody decided in time. Release its reserved budget.">Release budget</button>
                  </div>
                ) : b.isOwner ? (
                  <div className="ap-actions">
                    <button className="btn" disabled={!canAct} onClick={() => b.act('Payment declined', 'decline', { key: r.key })}>Decline</button>
                    <button className="btn primary" disabled={!canAct} onClick={() => b.act('Payment approved and sent', 'approve', { key: r.key })}>Approve</button>
                  </div>
                ) : <span className="muted small">Owner action</span>}
              </li>
            ))}
          </ul>
        </Panel>
      )}

      <div className="two-col">
        <Panel title="Agents" action={<a className="link" href="#/agents">Manage</a>} flush>
          {s.agents.length === 0 ? (
            <Empty title="No agents yet" action={<a className="btn primary" href="#/agents">Register an agent</a>}>
              <p>An agent gets its own limits and a key that can only request payments.</p>
            </Empty>
          ) : (
            <div className="table-wrap"><table className="table stack">
              <thead><tr><th>Agent</th><th className="r">Daily limit</th><th className="r">Spent today</th><th>Status</th></tr></thead>
              <tbody>
                {s.agents.map(([id, a]) => {
                  const used = (BigInt(a.spent) + BigInt(a.reserved)).toString();
                  return (
                    <tr key={id}>
                      <td><span className="mono">{short(id)}</span></td>
                      <td className="r num" data-label="Daily limit">{near(a.period_limit)}</td>
                      <td className="r nowrap" data-label="Spent today"><span className="num">{near(used)}</span> <MiniBar value={used} max={a.period_limit} /></td>
                      <td className="st" data-label="Status">{a.active ? <span className="badge green"><span className="dot" />Active</span> : <span className="badge gray"><span className="dot" />Disabled</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table></div>
          )}
        </Panel>

        <Panel title="Recent activity" action={<a className="link" href="#/activity">View all</a>} flush>
          {recent.length === 0 ? (
            <Empty title="No payments yet"><p>Requests from your agents will appear here.</p></Empty>
          ) : (
            <div className="table-wrap"><table className="table feed">
              <thead><tr><th>Agent</th><th className="r">Amount</th><th>Recipient</th><th>Status</th><th className="r">Time</th></tr></thead>
              <tbody>
                {recent.map((i) => (
                  <tr key={i.id} className={i.kind === 'blocked' ? 'row-blocked' : ''}>
                    <td className="c-agent"><span className="mono">{short(i.agent)}</span></td>
                    <td className="r num c-amt"><Amount yocto={i.amount} asset={i.asset} /></td>
                    <td className="c-rcpt">
                      <span className="mono">{short(i.recipient)}</span>
                      {i.reason && <div className="reason">{reasonText(i.reason)}</div>}
                    </td>
                    <td className="c-status"><StatusBadge kind={i.kind} /></td>
                    <td className="r muted nowrap c-time" title={new Date(i.at).toLocaleString()}>{ago(i.at, b.now)}</td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          )}
        </Panel>
      </div>
      <p className="footnote">All figures are read from the vault contract every 2 seconds. {STATUS.InFlight.label} means funds are reserved and the transfer hasn’t been confirmed yet.</p>
    </>
  );
}
