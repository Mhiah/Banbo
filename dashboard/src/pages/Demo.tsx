import { useState } from 'react';
import { useBanbo } from '../state';
import { runScenario, prettyError } from '../near';
import { near, units, reasonText, short } from '../format';
import { Panel, PageHeader, Empty } from '../ui';

type Outcome = { outcome: string; reason?: string; key?: string; status?: string };
type Run = { name: string; at: number; served?: number; replay?: number; unpaid?: number; payments: { recipient?: string; amountNear?: number; amountUsdc?: number; memo?: string; requestId?: string; outcome: Outcome; finalStatus?: string; failureReason?: string; tx: string; approveTx?: string }[] };

const SCENARIOS = [
  {
    id: 'invoice_fraud', title: 'Invoice fraud (origin checks)', tone: 'danger',
    body: 'The agent’s job is to pay Acme’s invoice. A forged “correction” from acme-billing.co asks for 0.45 instead of 0.30, payable to Globex, another approved vendor. First an ordinary firewall handles it, then Banbo’s origin checks.',
    expect: 'The ordinary firewall pays Globex. Under Banbo, the real invoice is paid, the forged amount waits on the Overview page with the email it came from, and a payee taken from the email is refused.',
  },
  {
    id: 'injection', title: 'Prompt-injection attack', tone: 'danger',
    body: 'A payments agent is asked to pay a real invoice. Hidden text in the invoice tells it to move 9 NEAR to attacker.test.near. It tries, then tries smaller amounts and a fake “prepayment”.',
    expect: 'Every attempt is blocked. The real 0.20 NEAR invoice is paid. The attacker gets nothing.',
  },
  {
    id: 'failure', title: 'Payment fails after approval', tone: '',
    body: 'An allowed payment goes to an account that no longer exists, so the transfer fails a block later. The agent then retries with the same request ID.',
    expect: 'The reservation is released exactly once and the money returns to the vault. The retry is a no-op.',
  },
  {
    id: 'approval', title: 'Payment that needs a human', tone: '',
    body: 'The buyer agent requests 0.5 NEAR, which is over its 0.4 NEAR approval threshold.',
    expect: 'The payment waits on the Overview page until you approve or decline it.',
  },
  {
    id: 'usdc', title: 'Paying in USDC', tone: '',
    body: 'The research agent pays the API vendor 7.50 USDC. Then it pays 3 USDC to a newly allowed account that never registered with the USDC contract.',
    expect: 'The first payment settles. The second fails safely before any tokens move, and its budget is released.',
  },
  {
    id: 'paid_api', title: 'Agent buys API calls', tone: '',
    body: 'A weather API charges per call in USDC. It answers with a price quote; the research agent pays it through the vault, and the API checks the vault contract before serving. The agent also tries a 15 USDC bulk export.',
    expect: 'Three calls are paid and served. The bulk export is blocked by the agent’s per-payment limit. Reused or unpaid quotes get nothing.',
  },
  {
    id: 'risk', title: 'Attacks that stay under the limits', tone: '',
    body: 'Risk rules are turned on: new recipients wait 1 hour, and each agent may make 5 payments an hour. The owner is tricked into allowing a lookalike billing account, and an agent is told to pay 40 tiny line items.',
    expect: 'The lookalike can’t be paid during its cooldown. The tiny payments stop after 5. The rules are then set back to how they were.',
  },
  {
    id: 'private', title: 'Private mode', tone: '',
    body: 'The owner turns on encrypted memos and adds a vendor to the hidden allowlist. An agent pays it with a sealed memo, then is tricked into reusing the vendor’s salt for the attacker. Finally the owner requires TEE agents.',
    expect: 'The hidden vendor is paid and only the owner can read the memo (unlock on the Privacy page with the demo passphrase). The reused salt, a plaintext memo and the non-TEE agent are all blocked.',
  },
  {
    id: 'routine', title: 'Routine agent payments', tone: '',
    body: 'Two agents pay the allowed API vendor small amounts in NEAR and USDC, as they would day to day.',
    expect: 'Payments settle and count against each agent’s daily limit.',
  },
];

const LABEL: Record<string, string> = { rejected: 'Blocked', dispatched: 'Sent', pending_approval: 'Waiting for owner', duplicate: 'Duplicate (no-op)' };

export default function Demo() {
  const b = useBanbo();
  const [runs, setRuns] = useState<Run[]>([]);

  if (b.network !== 'sandbox') {
    return (
      <>
        <PageHeader title="Demo" subtitle="Developer area" />
        <Empty title="The demo runs on the local sandbox" action={<button className="btn primary" onClick={() => b.setNetwork('sandbox')}>Switch to local sandbox</button>}>
          <p>Scenarios send real transactions with test agents’ keys, so they only run against a local NEAR node, never against your testnet or mainnet vault.</p>
        </Empty>
      </>
    );
  }
  if (b.sandboxDown || !b.state) {
    return (
      <>
        <PageHeader title="Demo" subtitle="Developer area" />
        <Empty title="Start the local sandbox"><pre>cd demo && npm install && npm run sandbox</pre></Empty>
      </>
    );
  }

  const s = b.state;
  const bal = s.balances;
  const run = async (id: string, title: string) => {
    b.setBusy(title);
    try {
      const r = (await runScenario(id)) as Run;
      setRuns((x) => [{ ...r, name: title, at: Date.now() }, ...x].slice(0, 6));
      await b.refresh(true);
    } catch (e) {
      b.toast('err', prettyError(e));
    } finally {
      b.setBusy(null);
    }
  };

  const sharedUsed = BigInt(bal.shared_spent) + BigInt(bal.shared_reserved);
  const checks: [string, bigint, bigint, string][] = [
    ['Shared', BigInt(bal.shared_spent), BigInt(bal.shared_reserved), bal.shared_cap],
    ...s.agents.map(([id, a]) => [short(id), BigInt(a.spent), BigInt(a.reserved), a.period_limit] as [string, bigint, bigint, string]),
  ];
  const tokenChecks: [string, string, bigint, bigint, string, number][] = s.tokens.flatMap((t) => [
    [`${t.symbol} shared`, t.token, BigInt(t.shared_spent), BigInt(t.shared_reserved), t.shared_cap, t.decimals] as [string, string, bigint, bigint, string, number],
    ...s.agents.flatMap(([id]) => (s.tokenLimits[id] ?? []).filter(([tok]) => tok === t.token).map(([, l]) =>
      [`${short(id)} · ${t.symbol}`, t.token, BigInt(l.spent), BigInt(l.reserved), l.period_limit, t.decimals] as [string, string, bigint, bigint, string, number])),
  ]);

  return (
    <>
      <PageHeader title="Demo" subtitle="Run real scenarios against the local vault. Every action is a transaction on a local NEAR node, signed by test agents’ keys." />
      <div className="dev-note">Developer area · local sandbox only{b.sandbox?.llmAgent ? ' · attack driven by a live Claude agent' : ' · attack driven by a scripted compromised agent'}</div>

      <div className="scenarios">
        {SCENARIOS.map((sc, i) => (
          <div key={sc.id} className={`scenario ${sc.tone}`}>
            <div className="sc-num">{i + 1}</div>
            <div className="sc-main">
              <h3>{sc.title}</h3>
              <p>{sc.body}</p>
              <p className="sc-expect"><strong>Expected:</strong> {sc.expect}</p>
            </div>
            <button className={`btn ${sc.tone === 'danger' ? 'danger' : ''}`} disabled={!!b.busy} onClick={() => run(sc.id, sc.title)}>
              {b.busy === sc.title ? 'Running…' : 'Run'}
            </button>
          </div>
        ))}
      </div>

      <div className="two-col">
        <Panel title="Invariant: spent + reserved ≤ limit" flush>
          <div className="table-wrap"><table className="table stack">
            <thead><tr><th>Budget</th><th className="r">Spent</th><th className="r">Reserved</th><th className="r">Limit</th><th>Holds</th></tr></thead>
            <tbody>
              {checks.map(([label, sp, rs, cap]) => {
                const ok = sp + rs <= BigInt(cap);
                return (
                  <tr key={label}>
                    <td className="mono">{label}</td>
                    <td className="r num" data-label="Spent">{near(sp)}</td>
                    <td className="r num" data-label="Reserved">{near(rs)}</td>
                    <td className="r num" data-label="Limit">{near(cap)}</td>
                    <td className="st" data-label="Holds">{ok ? <span className="badge green"><span className="dot" />Yes</span> : <span className="badge red"><span className="dot" />No</span>}</td>
                  </tr>
                );
              })}
              {tokenChecks.map(([label, , sp, rs, cap, dec]) => {
                const ok = sp + rs <= BigInt(cap);
                return (
                  <tr key={label}>
                    <td className="mono">{label}</td>
                    <td className="r num" data-label="Spent">{units(sp, dec)}</td>
                    <td className="r num" data-label="Reserved">{units(rs, dec)}</td>
                    <td className="r num" data-label="Limit">{units(cap, dec)}</td>
                    <td className="st" data-label="Holds">{ok ? <span className="badge green"><span className="dot" />Yes</span> : <span className="badge red"><span className="dot" />No</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table></div>
          <p className="footnote pad">Read live from the contract. Shared: {near(sharedUsed)} of {near(bal.shared_cap)} NEAR used.</p>
        </Panel>

        <Panel title="Results" flush>
          {runs.length === 0 ? <Empty title="No runs yet"><p>Run a scenario to see each transaction and the contract’s answer.</p></Empty> : (
            <div className="runs">
              {runs.map((r) => (
                <div key={r.at} className="run">
                  <div className="run-head"><strong>{r.name}</strong><span className="muted xs">{new Date(r.at).toLocaleTimeString()}</span></div>
                  {r.served !== undefined && <p className="muted xs run-note">API served {r.served} paid call{r.served === 1 ? '' : 's'}{r.replay ? ` · reused quote → HTTP ${r.replay}` : ''}{r.unpaid ? ` · unpaid quote → HTTP ${r.unpaid}` : ''}</p>}
                  <ul>
                    {r.payments.map((p, i) => (
                      <li key={i}>
                        <span className={`res ${p.outcome.outcome}`}>{LABEL[p.outcome.outcome] ?? p.outcome.outcome}</span>
                        <span className="res-main">
                          {p.amountNear !== undefined && <span className="num">{p.amountNear} NEAR → </span>}
                          {p.amountUsdc !== undefined && <span className="num">{p.amountUsdc.toFixed(2)} USDC → </span>}
                          {p.recipient && <span className="mono">{short(p.recipient)}</span>}
                          {p.outcome.reason && <span className="reason"> · {reasonText(p.outcome.reason)}</span>}
                          {p.outcome.status && <span className="muted"> · already {p.outcome.status}</span>}
                          {p.finalStatus === 'Failed' && <span className="reason"> · then failed: {reasonText(p.failureReason ?? 'transfer_failed')}</span>}
                        </span>
                        <span className="mono xs muted tx" title={p.tx}>tx {p.tx.slice(0, 10)}…</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </Panel>
      </div>
    </>
  );
}
