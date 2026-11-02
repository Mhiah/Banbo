import { useState, type FormEvent } from 'react';
import { useBanbo } from '../state';
import { connectAgent, prettyError } from '../near';
import { Panel, PageHeader, Empty } from '../ui';
import { toYocto } from '../format';

const NAME = /^(?=.{2,32}$)[a-z\d]+([-_][a-z\d]+)*$/;
const PUBKEY = /^ed25519:[1-9A-HJ-NP-Za-km-z]{43,44}$/;

/**
 * Give an AI agent its own account and a key that can only ask this vault to
 * pay, then register it with limits. The agent's machine makes the key; only
 * the public half is pasted here.
 */
export default function ConnectAgent() {
  const b = useBanbo();
  const s = b.state!;
  const owner = b.writer?.accountId ?? '';
  const [f, setF] = useState({ name: '', publicKey: '', perTx: '0.3', daily: '1', approval: '0.2', fund: '0.5', allowance: '1' });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  if (b.network === 'sandbox') {
    return (<><PageHeader title="Connect an agent" /><Empty title="The local sandbox already has agents"><p className="muted">Use this page on testnet or mainnet.</p></Empty></>);
  }
  if (!b.isOwner || !b.handle) {
    return (<><PageHeader title="Connect an agent" /><Empty title="Connect the vault owner’s wallet">
      <p className="muted">Only the owner of {b.contractId} can add agents.</p>
    </Empty></>);
  }

  const name = f.name.trim().toLowerCase();
  const agent = `${name || 'my-agent'}.${owner}`;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      if (!NAME.test(name)) throw new Error('Agent name: 2–32 lowercase letters or digits, words joined by - or _.');
      const publicKey = f.publicKey.trim();
      if (!PUBKEY.test(publicKey)) throw new Error('Paste the public key that banbo-mcp keygen printed. It starts with ed25519: (never paste a private key here).');
      if (s.agents.some(([id]) => id === agent)) throw new Error(`${agent} is already an agent of this vault.`);
      const [perTx, daily, approval] = [toYocto(f.perTx), toYocto(f.daily), toYocto(f.approval)];
      if (BigInt(perTx) === 0n || BigInt(perTx) > BigInt(daily)) throw new Error('Max per payment must be above 0 and no more than the daily limit.');
      setErr(''); setBusy(true);
      await connectAgent(b.handle!, {
        owner, vault: b.contractId, agent, publicKey,
        fundYocto: toYocto(f.fund), allowanceYocto: toYocto(f.allowance),
        perTxMax: perTx, periodLimit: daily, approvalThreshold: approval,
      });
      await b.refresh(true);
      b.toast('ok', `Agent ${agent} connected`);
      setDone(agent);
    } catch (x) {
      setErr(prettyError(x));
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    const net = b.network;
    const config = JSON.stringify({ mcpServers: { banbo: {
      command: 'node',
      args: ['/path/to/Banbo/mcp/src/index.js'],
      env: { BANBO_NETWORK: net, BANBO_VAULT: b.contractId, BANBO_AGENT_ACCOUNT: done, BANBO_CREDENTIALS_FILE: '/path/to/.banbo/agent-key.json' },
    } } }, null, 2);
    return (
      <>
        <PageHeader title="Agent connected" subtitle={`${done} can now ask ${b.contractId} to pay, within the limits you set.`} />
        <Panel title="Add Banbo to the agent">
          <p className="small">On the agent’s machine, add this to the MCP settings (for Claude Desktop: Settings → Developer → Edit Config). Replace the two paths: where you cloned Banbo, and the key file <span className="mono">banbo-mcp keygen</span> saved.</p>
          <pre className="mono small">{config}</pre>
          <button className="btn" onClick={() => { void navigator.clipboard?.writeText(config); b.toast('ok', 'Copied'); }}>Copy</button>
          <p className="muted xs">The key on that machine can only call <span className="mono">request_payment</span> on this vault. It can’t move the agent’s own NEAR or change any rule. Give it a mandate on the Mandates page.</p>
        </Panel>
      </>
    );
  }

  return (
    <>
      <PageHeader title="Connect an agent" subtitle="Give an AI agent its own account and a key that can only ask this vault to pay." />
      <Panel title="1. On the agent’s machine">
        <p className="small">In the Banbo folder, run this. It saves the agent’s private key on that machine and prints its public key:</p>
        <pre className="mono small">node mcp/src/index.js keygen</pre>
      </Panel>
      <Panel title="2. Here">
        <form className="form" onSubmit={submit}>
          <label className="field">
            <span>Agent name</span>
            <input value={f.name} onChange={set('name')} placeholder="my-agent" spellCheck={false} autoComplete="off" />
            <small>Its account will be <span className="mono">{agent}</span>, created by your wallet.</small>
          </label>
          <label className="field">
            <span>Agent’s public key</span>
            <input value={f.publicKey} onChange={set('publicKey')} placeholder="ed25519:…" spellCheck={false} autoComplete="off" />
            <small>The line keygen printed. It can only call request_payment on {b.contractId}.</small>
          </label>
          <div className="form-row">
            <label className="field"><span>Max per payment (NEAR)</span><input value={f.perTx} onChange={set('perTx')} inputMode="decimal" /></label>
            <label className="field"><span>Daily limit (NEAR)</span><input value={f.daily} onChange={set('daily')} inputMode="decimal" /></label>
            <label className="field"><span>Ask me above (NEAR)</span><input value={f.approval} onChange={set('approval')} inputMode="decimal" /></label>
          </div>
          <div className="form-row two">
            <label className="field"><span>Agent account balance (NEAR)</span><input value={f.fund} onChange={set('fund')} inputMode="decimal" />
              <small>From your wallet, for the agent account’s storage and gas.</small></label>
            <label className="field"><span>Key gas allowance (NEAR)</span><input value={f.allowance} onChange={set('allowance')} inputMode="decimal" />
              <small>The most gas the key may spend. About 0.01 NEAR per payment.</small></label>
          </div>
          {err && <p className="form-err" role="alert">{err}</p>}
          <div className="form-actions">
            <button className="btn primary" disabled={busy}>{busy ? 'Waiting for confirmation…' : 'Create agent and register it'}</button>
          </div>
          <p className="muted xs">Your wallet signs two transactions: one creates the agent’s account with only this restricted key, the other registers it on the vault with these limits.</p>
        </form>
      </Panel>
    </>
  );
}
