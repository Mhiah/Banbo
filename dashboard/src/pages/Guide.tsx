import { useEffect, useRef, useState, type ReactNode } from 'react';
import { PageHeader, Panel } from '../ui';
import { STATUS, type Kind } from '../activity';
import { REASONS } from '../format';

type Section = { id: string; title: string; body: ReactNode };

/** A field and what to put in it. */
function Fields({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="guide-fields">
      {rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
    </dl>
  );
}

const SECTIONS: Section[] = [
  {
    id: 'how',
    title: 'How Banbo works',
    body: <>
      <p>Banbo is a vault on NEAR that your AI agents pay from. The money stays in the vault contract. Your agents never hold it, and they can only <em>ask</em> the vault to pay. The contract checks every request against your rules before anything is sent.</p>
      <h3>What the contract checks</h3>
      <ul>
        <li><strong>Who may be paid:</strong> only accounts on your allowlist.</li>
        <li><strong>How much:</strong> a maximum per payment, a daily limit per agent, and a shared daily limit for all agents.</li>
        <li><strong>Who said so:</strong> inside a mandate, each payment carries labels saying where its recipient and amount came from. A recipient taken from an email or web page is refused. An amount from a sender you don’t trust is held for you.</li>
        <li><strong>When you decide:</strong> payments above an agent’s approval amount wait for you.</li>
      </ul>
      <p>The “who said so” check follows CaMeL, from <em>Defeating Prompt Injections by Design</em> (Debenedetti et al., Google, Google DeepMind and ETH Zurich, 2025). Banbo enforces its rule in the NEAR contract that holds the money. <a className="link" href="https://arxiv.org/abs/2503.18813" target="_blank" rel="noreferrer">Read the paper ↗</a></p>
      <h3>Who does what</h3>
      <Fields rows={[
        ['You (the owner)', 'Fund the vault, add agents, set the rules and mandates, approve held payments. Every change is signed by your wallet.'],
        ['Your agent', 'Asks the vault to pay. Its key can call one thing only: request a payment from this vault.'],
        ['The contract', 'Decides every payment, and records every refusal with the rule that caused it.'],
      ]} />
    </>,
  },
  {
    id: 'start',
    title: 'Get started',
    body: <>
      <h3>1. Connect your wallet</h3>
      <p>Click <strong>Connect wallet</strong> at the top right and pick a NEAR wallet. Meteor Wallet works well on testnet; make sure the wallet is set to the same network as the dashboard (shown next to the button).</p>
      <h3>2. Your vault</h3>
      <p>If your wallet already owns a vault, it opens by itself. If not, the Overview offers <strong>Create a vault</strong>, which makes a new vault owned by your wallet in one transaction.</p>
      <Fields rows={[
        ['Vault name', 'Lowercase letters or digits, 2–32 characters. Your vault becomes name.factory account.'],
        ['Starting balance', 'NEAR moved from your wallet into the vault. A small part stays back for the vault’s storage and gas.'],
        ['Daily limit for all agents', 'The most all your agents together can spend in one day. You can change it later in Spending Rules.'],
      ]} />
      <p>If your vault has a different name and doesn’t open by itself, enter its account once in <strong>Settings</strong>; it is remembered for your wallet.</p>
      <h3>3. Next steps</h3>
      <p>Add the companies your agents may pay (<strong>Spending Rules → Allowed recipients</strong>), then connect an agent.</p>
    </>,
  },
  {
    id: 'agents',
    title: 'Connect an agent',
    body: <>
      <p>An agent gets its own NEAR account and a key that can only ask your vault to pay. Go to <strong>Agents → Connect a new agent</strong>.</p>
      <h3>1. On the agent’s computer</h3>
      <p>Run <code>node mcp/src/index.js keygen</code> from the Banbo folder. It saves the private key on that computer and prints a public key. The private key never leaves that computer.</p>
      <h3>2. In the dashboard</h3>
      <Fields rows={[
        ['Agent name', 'The agent’s account becomes name.your-account.'],
        ['Agent’s public key', 'The ed25519:… key that keygen printed.'],
        ['Max per payment', 'The largest single payment this agent can ask for.'],
        ['Daily limit', 'The most this agent can spend in one day.'],
        ['Ask me above', 'Payments above this wait for your approval.'],
        ['Agent account balance', 'NEAR to create the agent’s account with.'],
        ['Key gas allowance', 'NEAR the agent’s key may spend on transaction fees. Each payment uses about 0.01 NEAR.'],
      ]} />
      <p>Your wallet signs two transactions: one creates the agent’s account with the restricted key, one adds the agent to the vault. The page then shows the setup to paste into your agent (see <strong>Use it from your agent</strong>).</p>
      <p>To change an agent’s limits later: <strong>Agents → Edit limits</strong>. To stop an agent at once: <strong>Disable</strong>.</p>
    </>,
  },
  {
    id: 'rules',
    title: 'Spending rules',
    body: <>
      <p>All of these are enforced by the contract. Each change shows the old and new value, and is applied only after your wallet signs it and the network confirms it.</p>
      <Fields rows={[
        ['Shared daily limit', 'The most all agents together can spend per day.'],
        ['Per-agent limits', 'Max per payment, daily limit, and the amount above which a payment waits for you.'],
        ['Allowed recipients', 'The only accounts agents may pay. Anything else is refused.'],
        ['New recipient cooldown', 'Minutes before a newly allowed recipient can be paid (0 = off). Gives you time to notice a lookalike account you were tricked into adding.'],
        ['Payments per agent per hour', 'Stops an agent splitting one big payment into many small ones (0 = no limit).'],
        ['Approval window', 'A payment waiting for you expires after this. Its reserved budget is released and nothing is sent.'],
        ['Payment records kept', 'How many finished records the contract keeps. Older ones are deleted to free storage; the public chain history keeps everything.'],
        ['Budget period', 'How often the daily counters reset. Set when the vault was created.'],
        ['Pause all payments', 'Refuses every new agent payment at once, until you resume.'],
      ]} />
    </>,
  },
  {
    id: 'mandates',
    title: 'Mandates',
    body: <>
      <p>A mandate gives one agent one job, for example “pay Acme’s October invoice”. It decides who the agent may pay for that job, how much, until when, and which senders may set an amount. Go to <strong>Mandates → New mandate</strong>.</p>
      <Fields rows={[
        ['Mandate id', 'A short name, e.g. acme-october. Letters, numbers, dots, dashes or underscores.'],
        ['Agent', 'The agent doing the job.'],
        ['What the job is', 'Write it yourself. The agent’s planner reads it. Don’t paste emails here.'],
        ['Who it may pay', 'One or more accounts, separated by commas. They must already be allowed recipients.'],
        ['Asset', 'NEAR, or a token the vault holds (such as USDC).'],
        ['Budget', 'The most this mandate can spend in total. It is a ceiling, not a transfer.'],
        ['Max per payment', 'The largest single payment under this mandate.'],
        ['Trust amounts from', 'Senders allowed to set an amount without your review, e.g. email:acme.com. Leave empty to review every amount that comes from a document.'],
        ['Ends in (days)', 'After this the mandate stops accepting payments.'],
      ]} />
      <h3>What happens to each payment</h3>
      <ul>
        <li>Recipient came from you or the mandate, amount from you or a trusted sender: <strong>paid</strong> (within all your limits).</li>
        <li>Amount came from a sender you don’t trust: <strong>held for you</strong>, showing which email or page it came from.</li>
        <li>Recipient came from an email, page or file: <strong>refused</strong>.</li>
      </ul>
      <h3>Who may send labels</h3>
      <p>The contract only believes an agent’s labels if the agent proved its code with an Intel TDX attestation, or if you <strong>Vouch</strong> for it (for example, an agent running on your own server). Each payment records which one applied.</p>
      <p><strong>Close</strong> ends a mandate early. <strong>Remove</strong> deletes a closed mandate’s record to free storage.</p>
    </>,
  },
  {
    id: 'approvals',
    title: 'Approving payments',
    body: <>
      <p>Held payments appear on <strong>Overview → Needs your approval</strong>. Each one says why it was held:</p>
      <ul>
        <li><strong>Above this agent’s approval amount.</strong></li>
        <li><strong>Amount came from</strong> a sender you don’t trust, with the exact email or page.</li>
      </ul>
      <p><strong>Approve</strong> sends it. <strong>Decline</strong> releases the reserved budget and sends nothing. If nobody decides within the approval window, it expires and nothing is sent.</p>
    </>,
  },
  {
    id: 'activity',
    title: 'Activity and statuses',
    body: <>
      <p><strong>Activity</strong> lists every payment and every refused attempt. Click one to see its details and transaction.</p>
      <Fields rows={(Object.keys(STATUS) as Kind[]).map((k) => [STATUS[k].label, STATUS[k].help])} />
      <h3>Why a payment was refused</h3>
      <Fields rows={Object.entries(REASONS).map(([code, text]) => [text, <code key={code}>{code}</code>])} />
    </>,
  },
  {
    id: 'privacy',
    title: 'Privacy',
    body: <>
      <Fields rows={[
        ['Encrypted memos', 'Payment notes are sealed to your key, so only you can read them. Unlock them on this device with your passphrase.'],
        ['Hidden vendors', 'Recipients stored as fingerprints instead of names, so your vendor list isn’t public.'],
        ['TEE agents', 'Require agents to prove, with an Intel TDX attestation checked by the contract, which code they run.'],
      ]} />
      <p><strong>What stays public:</strong> the amounts and recipients of payments that are actually made. Private mode hides your vendor list and notes, not the payments themselves.</p>
    </>,
  },
  {
    id: 'use',
    title: 'Use it from your agent',
    body: <>
      <p>Banbo works with any AI agent that supports MCP (Model Context Protocol), such as Claude Desktop, Claude Code or Cursor. After <strong>Connect an agent</strong>, paste the setup it shows into your agent’s MCP settings. The agent then has these tools:</p>
      <Fields rows={[
        ['banbo_status', 'Its limits, what it has spent and has left.'],
        ['banbo_list_mandates', 'The mandates you gave it.'],
        ['banbo_pay', 'Pay an allowed recipient. The contract applies every rule.'],
        ['banbo_pay_invoice', 'Pay an emailed invoice under a mandate. The labels are worked out by Banbo, never by the AI model.'],
        ['banbo_payment_status', 'Whether a payment was paid, held, refunded, declined, expired or refused.'],
      ]} />
      <p>A payment is reported as paid only after the network confirms it.</p>
    </>,
  },
  {
    id: 'safety',
    title: 'Safety',
    body: <>
      <ul>
        <li>Your agent’s key can only ask this vault to pay. It can’t move the vault’s money, change rules or call anything else.</li>
        <li>Only the owner’s wallet can change rules, mandates or agents, and every change is signed by you.</li>
        <li>Anyone can view a vault. Only its owner can change it.</li>
        <li>If something looks wrong, <strong>Spending Rules → Pause all payments</strong> stops every agent at once.</li>
        <li>Banbo is unaudited and runs on testnet. Don’t put real funds in it.</li>
      </ul>
    </>,
  },
];

const readSection = () => new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('s') ?? SECTIONS[0].id;

export default function Guide() {
  const [id, setId] = useState(readSection);
  useEffect(() => {
    const on = () => setId(readSection());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  const section = SECTIONS.find((x) => x.id === id) ?? SECTIONS[0];
  const nav = useRef<HTMLElement>(null);
  // On a phone the section list scrolls sideways: keep the open one in view.
  useEffect(() => { nav.current?.querySelector<HTMLElement>('.active')?.scrollIntoView?.({ block: 'nearest', inline: 'center' }); }, [section.id]);

  return (
    <>
      <PageHeader title="Guide" subtitle="Everything you can do with Banbo, step by step." />
      <div className="guide">
        <nav ref={nav} className="guide-nav" aria-label="Guide sections">
          {SECTIONS.map((x) => (
            <a key={x.id} href={`#/guide?s=${x.id}`} className={x.id === section.id ? 'active' : ''} aria-current={x.id === section.id ? 'page' : undefined}>{x.title}</a>
          ))}
        </nav>
        <Panel title={section.title}>
          <div className="guide-body">{section.body}</div>
        </Panel>
      </div>
    </>
  );
}
