// Runs a validated plan. Every value keeps its label: constants from the
// plan are owner-origin, extracted fields carry their document's label.
// Each payment goes to the vault with its labels, and the contract decides.
// The interpreter also predicts the contract's answer so the trace can say
// why, but it never skips the vault: a refusal recorded on-chain is the
// evidence.
import { Labeled, OWNER, toContract, isOwner, describe, documentPaymentId } from './labels.js';
import { extract } from './reader.js';

let seq = 0;
const newId = () => `o-${Date.now().toString(36)}-${(++seq).toString(36)}`;

/** What the contract's origin rule will say (for the trace; the vault decides). */
export function expectedVerdict(task, to, amountOrigin) {
  if (!isOwner(to.origin)) return { verdict: 'refused', reason: 'recipient_from_untrusted_source' };
  if (!task.payees.includes(to.value)) return { verdict: 'refused', reason: 'recipient_not_in_task' };
  if (!isOwner(amountOrigin) && !task.trusted_sources.includes(amountOrigin.source)) {
    return { verdict: 'held', reason: 'amount_from_untrusted_source' };
  }
  return { verdict: 'allowed' };
}

/**
 * plan: validated plan. docs: [{id, ...document}]. task: the on-chain task.
 * pay({requestId, recipient, amount (units string), token, memo, origin}) → {outcome, tx}
 * toUnits(decimalString) → units string for the task's asset.
 */
export async function runPlan({ plan, docs, task, llm, pay, toUnits, onEvent = () => {} }) {
  const env = new Map();
  const byId = new Map(docs.map((d) => [d.id, d]));
  const value = (v) => (v == null ? new Labeled('', OWNER) : 'const' in v ? new Labeled(v.const, OWNER) : env.get(v.ref));
  const trace = [];
  for (const step of plan.steps) {
    if (step.op === 'extract') {
      const doc = byId.get(step.doc);
      const fields = await extract({ llm, doc, fields: step.fields });
      for (const [k, lv] of Object.entries(fields)) env.set(`${step.as}.${k}`, lv);
      const ev = { op: 'extract', doc: step.doc, source: doc.source, fields: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, v.value])) };
      trace.push(ev);
      onEvent(ev);
      continue;
    }
    const to = value(step.to);
    const amount = value(step.amount);
    const memo = value(step.memo);
    const origin = { task_id: task.id, recipient: toContract(to.origin), amount: toContract(amount.origin) };
    const ev = {
      op: 'pay',
      recipient: to.value,
      amount: amount.value,
      recipient_origin: describe(to.origin),
      amount_origin: describe(amount.origin),
      origin,
      expected: expectedVerdict(task, to, amount.origin),
    };
    if (!to.value || !amount.value) {
      ev.outcome = { outcome: 'skipped', reason: 'the reader found no recipient or amount' };
    } else {
      try {
        // An amount read from a document gets an id tied to that document,
        // so paying the same invoice again is a duplicate to the vault.
        const requestId = isOwner(amount.origin) ? newId() : documentPaymentId('o', task.id, amount.origin, to.value);
        const r = await pay({ requestId, recipient: to.value, amount: toUnits(amount.value), token: task.token ?? null, memo: memo.value ?? '', origin });
        ev.outcome = r.outcome;
        ev.tx = r.tx;
      } catch (e) {
        ev.outcome = { outcome: 'error', reason: String(e.message ?? e).slice(0, 300) };
      }
    }
    trace.push(ev);
    onEvent(ev);
  }
  return { trace, summary: summarize(trace) };
}

/** Written from the trace, not by a model, so no document can put words in it. */
export function summarize(trace) {
  const lines = [];
  for (const t of trace) {
    if (t.op !== 'pay') continue;
    const o = t.outcome ?? {};
    const what = `${t.amount} to ${t.recipient}`;
    if (o.outcome === 'dispatched') lines.push(`Paid ${what}.`);
    else if (o.outcome === 'pending_approval') lines.push(`Held ${what} for the owner (amount came from ${t.amount_origin}).`);
    else if (o.outcome === 'rejected') lines.push(`Refused ${what}: ${o.reason} (recipient from ${t.recipient_origin}).`);
    else if (o.outcome === 'duplicate') lines.push(`Already requested ${what}.`);
    else lines.push(`Did not pay ${what}: ${o.reason ?? o.outcome}.`);
  }
  return lines.join('\n') || 'No payments.';
}
