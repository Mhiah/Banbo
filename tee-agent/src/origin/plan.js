// The plan language. The planner (privileged model) writes a plan from the
// owner's request alone; it never sees an email or a web page. A plan can
// only extract fields from documents and pay. Anything else is rejected
// before it runs, so a plan can't smuggle in new capabilities.

export const FIELD_TYPES = ['decimal', 'account', 'text'];
const NAME = /^[a-z][a-z0-9_]{0,19}$/;
const DOC_ID = /^d[0-9]{1,2}$/;
const DECIMAL = /^\d{1,12}(\.\d{1,24})?$/;
const MAX_STEPS = 12;
const MAX_PAYMENTS = 5;
const MAX_FIELDS = 8;

function checkValue(v, where, defined, { decimal = false, required = true } = {}) {
  if (v == null) {
    if (required) throw new Error(`${where} is required`);
    return;
  }
  if (typeof v !== 'object' || Array.isArray(v)) throw new Error(`${where} must be {"const": ...} or {"ref": ...}`);
  const keys = Object.keys(v);
  if (keys.length !== 1) throw new Error(`${where} must have exactly one of const or ref`);
  if ('const' in v) {
    if (typeof v.const !== 'string' || v.const.length > 120) throw new Error(`${where}.const must be a short string`);
    if (decimal && !DECIMAL.test(v.const)) throw new Error(`${where}.const must be a decimal like "12.50"`);
    return;
  }
  if ('ref' in v) {
    if (typeof v.ref !== 'string' || !defined.has(v.ref)) throw new Error(`${where}.ref "${v.ref}" is not an extracted field`);
    return;
  }
  throw new Error(`${where} must be {"const": ...} or {"ref": ...}`);
}

/** Throws with a precise message if the plan is not valid for these documents. */
export function validatePlan(plan, docIds) {
  if (!plan || typeof plan !== 'object' || !Array.isArray(plan.steps)) throw new Error('plan must be {"steps": [...]}');
  if (Object.keys(plan).some((k) => k !== 'steps')) throw new Error('plan has unknown keys');
  if (plan.steps.length === 0 || plan.steps.length > MAX_STEPS) throw new Error(`plan needs 1-${MAX_STEPS} steps`);
  const defined = new Set();
  const names = new Set();
  let payments = 0;
  plan.steps.forEach((s, i) => {
    const at = `step ${i + 1}`;
    if (!s || typeof s !== 'object') throw new Error(`${at} is not an object`);
    if (s.op === 'extract') {
      const allowed = new Set(['op', 'doc', 'as', 'fields']);
      if (Object.keys(s).some((k) => !allowed.has(k))) throw new Error(`${at} has unknown keys`);
      if (!DOC_ID.test(s.doc ?? '') || !docIds.includes(s.doc)) throw new Error(`${at}: unknown document ${s.doc}`);
      if (!NAME.test(s.as ?? '') || names.has(s.as)) throw new Error(`${at}: "as" must be a new lowercase name`);
      names.add(s.as);
      const f = s.fields;
      if (!f || typeof f !== 'object' || Array.isArray(f)) throw new Error(`${at}: fields must be an object`);
      const entries = Object.entries(f);
      if (entries.length === 0 || entries.length > MAX_FIELDS) throw new Error(`${at}: 1-${MAX_FIELDS} fields`);
      for (const [k, t] of entries) {
        if (!NAME.test(k)) throw new Error(`${at}: bad field name ${k}`);
        if (!FIELD_TYPES.includes(t)) throw new Error(`${at}: field ${k} must be one of ${FIELD_TYPES.join(', ')}`);
        defined.add(`${s.as}.${k}`);
      }
    } else if (s.op === 'pay') {
      const allowed = new Set(['op', 'to', 'amount', 'memo']);
      if (Object.keys(s).some((k) => !allowed.has(k))) throw new Error(`${at} has unknown keys`);
      checkValue(s.to, `${at}.to`, defined);
      checkValue(s.amount, `${at}.amount`, defined, { decimal: true });
      checkValue(s.memo, `${at}.memo`, defined, { required: false });
      if (++payments > MAX_PAYMENTS) throw new Error(`at most ${MAX_PAYMENTS} payments per plan`);
    } else {
      throw new Error(`${at}: op must be "extract" or "pay"`);
    }
  });
  if (payments === 0) throw new Error('plan makes no payment');
  return plan;
}

/** Parse the first JSON object in a model's reply. */
export function parseJsonReply(text) {
  const s = String(text ?? '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('no JSON object in the reply');
  return JSON.parse(s.slice(start, end + 1));
}
