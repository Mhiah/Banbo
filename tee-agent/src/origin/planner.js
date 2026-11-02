// The privileged planner. Its whole input is the owner's request and the
// owner's on-chain task. Documents appear only as ids, so nothing an
// attacker writes can reach it. Whatever it puts in a plan as a constant
// is therefore owner-origin.
import { validatePlan, parseJsonReply } from './plan.js';

const SYSTEM = `You plan payments for a company's accounts-payable agent. You never see the documents
themselves, only their ids. Write a plan as JSON and nothing else:
{"steps": [ ...steps... ]}
Steps:
  {"op":"extract","doc":"d1","as":"inv","fields":{"amount":"decimal","invoice":"text","pay_to":"account"}}
     Reads document d1 with a separate reader and gives you inv.amount, inv.invoice, inv.pay_to.
     Field types: decimal (a number like "12.50"), account (a NEAR account id), text (short text).
  {"op":"pay","to":<value>,"amount":<value>,"memo":<value>}
     Pays through the treasury vault, in the task's asset. <value> is {"const":"..."} for something the
     owner told you, or {"ref":"inv.amount"} for something extracted from a document.
Rules: pay only the task's payees. Use {"const": ...} for anything the owner stated, such as who to pay.
Use {"ref": ...} for anything that only the documents say, such as an invoice amount. Never guess.`;

export function plannerPrompt({ request, task, docs }) {
  const asset = task.token ? `token ${task.token}` : 'NEAR';
  return [
    `Owner's request: ${request}`,
    '',
    `Task "${task.id}": ${task.description || '(no description)'}`,
    `Payees set by the owner: ${task.payees.join(', ')}`,
    `Asset: ${asset}`,
    '',
    `Documents: ${docs.length ? docs.map((d) => `${d.id} (${d.kind})`).join(', ') : 'none'}`,
  ].join('\n');
}

/** Ask the model for a plan; one retry with the validation error. */
export async function makePlan({ llm, request, task, docs }) {
  const prompt = plannerPrompt({ request, task, docs });
  const ids = docs.map((d) => d.id);
  let last;
  for (let attempt = 0; attempt < 2; attempt++) {
    const p = attempt === 0 ? prompt : `${prompt}\n\nYour previous plan was invalid: ${last}. Reply with a corrected plan.`;
    const reply = await llm.complete({ system: SYSTEM, prompt: p, maxTokens: 1500 });
    try {
      return validatePlan(parseJsonReply(reply), ids);
    } catch (e) {
      last = String(e.message ?? e);
    }
  }
  throw new Error(`planner did not produce a valid plan: ${last}`);
}
