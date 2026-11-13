// The Banbo MCP tools. The vault contract makes every decision; these tools
// only prepare requests honestly and report the contract's answer in words.
//
// The one thing an AI model never supplies is an origin label. For invoice
// payments the server derives the labels itself: the amount's label comes
// from the email's DKIM-verified sender domain, and only if that exact amount
// is written in the email; the recipient is labelled as the owner's only if
// the owner listed it as one of the task's payees. A prompt-injected model
// therefore can't claim an amount came from a trusted sender.
import crypto from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { emailDocument } from '../../tee-agent/src/origin/sources.js';
import { OWNER, toContract, documentPaymentId } from '../../tee-agent/src/origin/labels.js';
import { parseUnits, formatUnits, amountsIn } from './units.js';
import { explain, STATUS } from './reasons.js';

const NEAR_DECIMALS = 24;
const REQUEST_ID = /^[A-Za-z0-9._:-]{1,48}$/;

const text = (s) => ({ content: [{ type: 'text', text: s }] });
const fail = (s) => ({ content: [{ type: 'text', text: s }], isError: true });
const newRequestId = () => `mcp-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;

/** NEAR, or a NEP-141 token the vault supports, by account id or symbol. */
async function resolveToken(vault, token) {
  if (!token || token.toUpperCase() === 'NEAR') return { token: null, symbol: 'NEAR', decimals: NEAR_DECIMALS };
  const tokens = await vault.view('list_tokens');
  const t = tokens.find((x) => x.token === token) ?? tokens.find((x) => x.symbol.toLowerCase() === token.toLowerCase());
  if (!t) throw new Error(`the vault does not accept "${token}". It accepts NEAR${tokens.map((x) => `, ${x.symbol} (${x.token})`).join('')}`);
  return { token: t.token, symbol: t.symbol, decimals: t.decimals };
}

/** Send a request and describe what the contract did with it. */
async function pay(vault, req, asset) {
  const amountText = `${formatUnits(req.amount, asset.decimals)} ${asset.symbol}`;
  const { outcome, tx } = await vault.requestPayment(req);
  const o = outcome ?? {};
  const facts = { request_id: req.requestId, outcome: o.outcome, reason: o.reason ?? null, tx: tx ?? null };
  let line;
  if (o.outcome === 'rejected') {
    line = `Refused by the vault contract: ${explain(o.reason)} (${o.reason}). Nothing was paid.`;
  } else if (o.outcome === 'duplicate') {
    line = `This request id was already used, so nothing new happened. That payment is ${STATUS[o.status] ?? o.status}.`;
  } else if (o.outcome === 'pending_approval' || o.outcome === 'dispatched') {
    const r = await vault.view('get_request', { key: o.key });
    facts.status = r?.status ?? null;
    facts.hold_reason = r?.hold_reason ?? null;
    if (r?.status === 'PendingApproval') {
      line = `Held for the owner: ${explain(r.hold_reason)} The ${amountText} is reserved until the owner approves or declines it. Nothing has been paid yet.`;
    } else if (r?.status === 'Settled') {
      line = `Paid ${amountText} to ${req.recipient}. The network confirmed the transfer.`;
    } else if (r?.status === 'Failed') {
      line = `The transfer of ${amountText} to ${req.recipient} failed on-chain${r.failure_reason ? ` (${r.failure_reason})` : ''}. The reservation was released and the funds are back in the vault.`;
    } else {
      line = `Sent ${amountText} to ${req.recipient}, but the network has not confirmed it yet. Check again with banbo_payment_status.`;
    }
  } else {
    line = 'The vault returned an unexpected answer. Check with banbo_payment_status before trying again.';
  }
  return text(`${line}\n\n${JSON.stringify(facts, null, 2)}`);
}

/**
 * vault: from openVault (or a test double with the same shape).
 * salts: hidden-vendor salts from the runtime config, never from the model.
 * dkimResolver: DNS TXT resolver for DKIM keys (real DNS when omitted).
 */
export function createServer({ vault, salts = {}, dkimResolver } = {}) {
  const server = new McpServer({ name: 'banbo', version: '0.1.0' });
  const me = vault.accountId;

  server.registerTool('banbo_status', {
    title: 'Banbo wallet status',
    description: 'Show this agent\'s spending limits, what it has spent and has left this period, the payments it may still make this hour, and whether the vault is paused. Read-only.',
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async () => {
    const [cfg, agent, rate, tokenLimits, tokens, balances, tee, vouched] = await Promise.all([
      vault.view('get_config'), vault.view('get_agent', { agent: me }), vault.view('get_agent_rate', { agent: me }),
      vault.view('get_agent_token_limits', { agent: me }), vault.view('list_tokens'), vault.view('get_balances'),
      vault.view('get_agent_tee', { agent: me }), vault.view('list_vouched'),
    ]);
    if (!agent) return fail(`${me} is not an agent of the vault ${vault.vaultId}. Ask the owner to add it.`);
    const near = (v) => `${formatUnits(v, NEAR_DECIMALS)} NEAR`;
    const left = BigInt(agent.period_limit.toString()) - BigInt(agent.spent) - BigInt(agent.reserved);
    const lines = [
      `Vault ${vault.vaultId} on ${vault.networkId}. Agent ${me}${agent.active ? '' : ' (DISABLED by the owner)'}.`,
      cfg.paused ? 'The vault is PAUSED: no payments go out.' : 'The vault is open.',
      `NEAR: up to ${near(agent.per_tx_max)} per payment, ${near(agent.period_limit)} per period; spent ${near(agent.spent)}, reserved ${near(agent.reserved)}, ${near(left > 0n ? left : 0n)} left. Payments over ${near(agent.approval_threshold)} wait for the owner.`,
      `The vault has ${near(balances.available)} available to agents.`,
    ];
    for (const [token, l] of tokenLimits) {
      const t = tokens.find((x) => x.token === token);
      if (!t) continue;
      const u = (v) => `${formatUnits(v, t.decimals)} ${t.symbol}`;
      const tl = BigInt(l.period_limit) - BigInt(l.spent) - BigInt(l.reserved);
      lines.push(`${t.symbol} (${token}): up to ${u(l.per_tx_max)} per payment, ${u(l.period_limit)} per period; ${u(tl > 0n ? tl : 0n)} left. Over ${u(l.approval_threshold)} waits for the owner.`);
    }
    if (cfg.max_payments_per_hour) lines.push(`Payments in the current one-hour window: ${rate.count ?? 0} of ${cfg.max_payments_per_hour}.`);
    // Same order as the contract: the owner's vouch first, then a TDX attestation.
    const labels = vouched.includes(me) ? 'accepted: vouched for by the owner'
      : tee && tee.valid_until_ms > Date.now() ? `accepted while this agent's TDX attestation is valid (until ${new Date(tee.valid_until_ms).toISOString()}) and its image is still approved`
        : 'not accepted (invoice payments under a task mandate will be refused)';
    lines.push(`Origin labels from this agent: ${labels}.`);
    if (cfg.require_origin) lines.push('The owner requires origin labels on every payment: use banbo_pay_invoice under a task mandate.');
    return text(lines.join('\n'));
  });

  server.registerTool('banbo_list_mandates', {
    title: 'List my Banbo task mandates',
    description: 'List the open task mandates the owner has given this agent: who it may pay, the budget left, the largest single payment, and which email senders are trusted to set an amount. Read-only.',
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async () => {
    const tasks = (await vault.view('list_tasks')).filter((t) => t.agent === me && !t.closed && t.expires_at_ms > Date.now());
    if (!tasks.length) return text('The owner has given this agent no open task mandates.');
    const out = [];
    for (const t of tasks) {
      const a = await resolveToken(vault, t.token).catch(() => ({ symbol: t.token, decimals: 0 }));
      const u = (v) => `${formatUnits(v, a.decimals)} ${a.symbol}`;
      const left = BigInt(t.budget) - BigInt(t.spent) - BigInt(t.reserved);
      out.push([
        `Mandate ${t.id}: ${t.description || '(no description)'}`,
        `  pays only: ${t.payees.join(', ')}`,
        `  budget left: ${u(left > 0n ? left : 0n)} of ${u(t.budget)}; at most ${u(t.max_per_payment)} per payment`,
        `  amounts trusted from: ${t.trusted_sources.length ? t.trusted_sources.join(', ') : 'nobody (every amount is held for the owner)'}`,
        `  ends: ${new Date(t.expires_at_ms).toISOString()}`,
      ].join('\n'));
    }
    return text(out.join('\n\n'));
  });

  server.registerTool('banbo_pay', {
    title: 'Pay through the Banbo vault',
    description: 'Ask the vault to pay an approved recipient in NEAR or a token the vault accepts (for example USDC). The vault contract checks the owner\'s rules (allowlist, limits, approvals) and may refuse the payment or hold it for the owner. For an invoice that arrived by email, use banbo_pay_invoice instead. Reusing a request_id never pays twice.',
    inputSchema: {
      recipient: z.string().min(2).max(64).describe('NEAR account to pay, e.g. vendor.near'),
      amount: z.string().max(40).describe('Amount as a decimal string in whole units, e.g. "0.25" (NEAR) or "7.50" (USDC)'),
      token: z.string().max(64).optional().describe('"NEAR" (default), a token symbol such as "USDC", or the token contract account'),
      memo: z.string().max(200).optional().describe('Short note for the owner; encrypted to the owner when the vault requires it'),
      request_id: z.string().regex(REQUEST_ID).optional().describe('Your id for this payment, to retry safely; one is generated if omitted'),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async ({ recipient, amount, token, memo = '', request_id }) => {
    try {
      const asset = await resolveToken(vault, token);
      const units = parseUnits(amount, asset.decimals);
      return await pay(vault, {
        requestId: request_id ?? newRequestId(), recipient, amount: units, token: asset.token, memo,
        recipientSalt: salts[recipient] ?? null,
      }, asset);
    } catch (e) {
      return fail(`Not sent: ${e.message}`);
    }
  });

  server.registerTool('banbo_pay_invoice', {
    title: 'Pay an emailed invoice under a task mandate',
    description: 'Pay an invoice that arrived by email, under a task mandate the owner created. Pass the complete raw email (headers and body, as downloaded, so its DKIM signature can be checked) and the amount to pay. The server labels where the recipient and amount came from (you cannot set the labels): the amount must appear in the email, and it counts as coming from the sender\'s domain only if the DKIM signature verifies. The vault then pays, holds the payment for the owner, or refuses it. One email pays one recipient at most once per mandate: sending the same invoice again does not pay again.',
    inputSchema: {
      mandate_id: z.string().min(1).max(64).describe('The mandate id from banbo_list_mandates'),
      email: z.string().min(20).max(200_000).describe('The complete raw email source (RFC 5322), including the DKIM-Signature header'),
      amount: z.string().max(40).describe('The amount to pay as written in the email, e.g. "0.30"'),
      recipient: z.string().min(2).max(64).optional().describe('One of the mandate\'s payees; defaults to the mandate\'s only payee'),
      memo: z.string().max(200).optional().describe('Short note for the owner, e.g. the invoice number'),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  }, async ({ mandate_id, email, amount, recipient, memo = '' }) => {
    try {
      const task = await vault.view('get_task', { id: mandate_id });
      if (!task) return fail(`Not sent: there is no task mandate "${mandate_id}". See banbo_list_mandates.`);
      if (task.agent !== me) return fail(`Not sent: mandate "${mandate_id}" belongs to another agent.`);
      const to = recipient ?? (task.payees.length === 1 ? task.payees[0] : null);
      if (!to) return fail(`Not sent: mandate "${mandate_id}" has several payees (${task.payees.join(', ')}); say which one in "recipient".`);
      const asset = await resolveToken(vault, task.token);
      const units = parseUnits(amount, asset.decimals);

      const doc = await emailDocument(email, dkimResolver ? { resolver: dkimResolver } : {});
      if (!amountsIn(doc.text, asset.decimals).has(units)) {
        return fail(`Not sent: ${amount} is not written in this email. Banbo only labels an amount with the email it came from, so pay the amount exactly as the invoice states it.`);
      }
      // The owner wrote the mandate's payee list, so a payee is the owner's
      // choice. Anything else could only have come from the document.
      const origin = {
        task_id: mandate_id,
        recipient: toContract(task.payees.includes(to) ? OWNER : doc.label),
        amount: toContract(doc.label),
      };
      // The id comes from the email itself, never from the model, so the
      // vault's exactly-once rule stops the same invoice being paid twice.
      // A payment that failed or expired moved no money and may be retried.
      let requestId = documentPaymentId('inv', mandate_id, doc.label, to);
      for (let retry = 1; retry <= 3; retry++) {
        const prev = await vault.view('get_request', { key: `${me}:${requestId}` });
        if (!prev || !['Failed', 'Expired'].includes(prev.status)) break;
        requestId = `${documentPaymentId('inv', mandate_id, doc.label, to)}-r${retry}`;
      }
      const res = await pay(vault, {
        requestId, recipient: to, amount: units, token: asset.token, memo, origin,
        recipientSalt: salts[to] ?? null,
      }, asset);
      const note = `Email sender: ${doc.verified ? `${doc.source.slice('email:'.length)} (DKIM verified)` : 'not verified (no valid DKIM signature matching the From address)'}; sha256 ${doc.label.digest}.`;
      res.content[0].text = `${res.content[0].text}\n\n${note}`;
      return res;
    } catch (e) {
      return fail(`Not sent: ${e.message}`);
    }
  });

  server.registerTool('banbo_payment_status', {
    title: 'Check a Banbo payment',
    description: 'Look up a payment this agent requested, by its request_id: paid, waiting for the owner, failed and refunded, declined or expired. Read-only.',
    inputSchema: { request_id: z.string().regex(REQUEST_ID).describe('The request_id returned when the payment was made') },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ request_id }) => {
    const r = await vault.view('get_request', { key: `${me}:${request_id}` });
    if (!r) {
      const blocked = (await vault.view('list_blocked', {})).find((b) => b.agent === me && b.request_id === request_id);
      if (blocked) return text(`Refused by the vault contract: ${explain(blocked.reason)} (${blocked.reason}). Nothing was paid.`);
      return fail(`No payment with request_id "${request_id}" from this agent (or it is older than the vault's history).`);
    }
    const facts = { request_id, status: r.status, recipient: r.recipient, amount: r.amount, token: r.token ?? 'NEAR', hold_reason: r.hold_reason ?? null, failure_reason: r.failure_reason ?? null };
    return text(`This payment is ${STATUS[r.status] ?? r.status}.\n\n${JSON.stringify(facts, null, 2)}`);
  });

  return server;
}
