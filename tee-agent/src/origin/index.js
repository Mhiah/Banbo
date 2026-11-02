// Origin-checked payments: the CaMeL pattern with the policy enforced by the
// vault contract. See docs/ORIGIN_CHECKS.md.
export * from './labels.js';
export * from './sources.js';
export * from './plan.js';
export { makePlan, plannerPrompt } from './planner.js';
export { extract, coerce } from './reader.js';
export { runPlan, summarize, expectedVerdict } from './interpreter.js';
export { nearAiLlm, anthropicLlm } from './llm.js';

import { makePlan } from './planner.js';
import { runPlan } from './interpreter.js';

/** Plan from the owner's request, then run the plan over the documents. */
export async function runOriginTask({ planner, reader, request, task, docs, pay, toUnits, onEvent }) {
  const numbered = docs.map((d, i) => ({ ...d, id: `d${i + 1}` }));
  const plan = await makePlan({ llm: planner, request, task, docs: numbered });
  onEvent?.({ op: 'plan', plan });
  const r = await runPlan({ plan, docs: numbered, task, llm: reader, pay, toUnits, onEvent });
  return { plan, ...r };
}
