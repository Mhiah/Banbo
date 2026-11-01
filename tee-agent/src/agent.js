// The agent loop. It thinks with NEAR AI Cloud private inference (an
// OpenAI-compatible API whose models run in TEEs), so prompts, invoices and
// memos stay inside confidential hardware end to end. Its only way to move
// money is the vault, which has the final word.

const SYSTEM = `You are a purchasing agent for a small company. You pay vendors and buy API data
from the company's NEAR treasury. Every payment goes through the treasury vault, which enforces the
company's rules and may refuse; if it does, report the reason and do not try to work around it.
Be brief. When finished, give a one-paragraph summary of what you paid and why.`;

export const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'call_paid_api',
      description: 'GET a paid API endpoint. If it asks for payment, pay the quote through the vault and fetch again. Returns the data or why it could not be bought.',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: 'Full https URL of the endpoint' } },
        required: ['url'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'request_payment',
      description: 'Pay a NEAR account from the treasury vault. Returns the vault decision: dispatched, pending_approval, rejected (with a reason) or duplicate.',
      parameters: {
        type: 'object',
        properties: {
          recipient: { type: 'string', description: 'NEAR account id' },
          amount: { type: 'string', description: 'Decimal amount, e.g. "2.50"' },
          asset: { type: 'string', description: '"NEAR" or a token symbol the vault holds, e.g. "USDC"' },
          memo: { type: 'string', description: 'What the payment is for. Sealed so only the owner can read it.' },
        },
        required: ['recipient', 'amount', 'asset', 'memo'],
        additionalProperties: false,
      },
    },
  },
];

/** "2.5" with 6 decimals → "2500000"; refuses anything that isn't a plain decimal. */
export function toUnits(amount, decimals) {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(String(amount).trim());
  if (!m) throw new Error(`bad amount ${amount}`);
  const frac = (m[2] ?? '').padEnd(decimals, '0');
  if (frac.length > decimals) throw new Error(`too many decimals in ${amount}`);
  return (BigInt(m[1]) * 10n ** BigInt(decimals) + BigInt(frac || '0')).toString();
}

let seq = 0;
const newId = () => `tee-${Date.now().toString(36)}-${(++seq).toString(36)}`;

/** The tools, bound to a vault. `salts` is the hidden-vendor config; the model never sees it. */
export function toolHandlers({ vault, vaultId, salts, fetchImpl = fetch }) {
  const pay = (args) => vault.requestPayment({ ...args, salts });
  return {
    async request_payment({ recipient, amount, asset, memo }) {
      let token = null, decimals = 24;
      if (asset.toUpperCase() !== 'NEAR') {
        const t = (await vault.view('list_tokens')).find((x) => x.symbol.toUpperCase() === asset.toUpperCase());
        if (!t) return { error: `the vault does not hold ${asset}` };
        token = t.token; decimals = t.decimals;
      }
      const r = await pay({ requestId: newId(), recipient, amount: toUnits(amount, decimals), token, memo });
      return { ...r.outcome, tx: r.tx };
    },
    async call_paid_api({ url }) {
      const first = await fetchImpl(url);
      if (first.status === 200) return { status: 'ok', data: (await first.json()).data };
      const body = await first.json().catch(() => ({}));
      if (first.status !== 402 || !body.quote) return { status: 'refused', http: first.status, error: body.error };
      const q = body.quote;
      if (q.vault !== vaultId) return { status: 'refused', error: 'quote_for_another_vault' };
      const r = await pay({ requestId: q.id, recipient: q.recipient, amount: q.price, token: q.token, memo: q.memo });
      const o = r.outcome ?? {};
      if (o.outcome === 'rejected') return { status: 'blocked', reason: o.reason };
      if (o.outcome === 'pending_approval') return { status: 'pending_approval' };
      const second = await fetchImpl(url, { headers: { 'x-banbo-payment': `${vault.accountId}:${q.id}` } });
      const out = await second.json().catch(() => ({}));
      return second.status === 200 ? { status: 'ok', data: out.data, tx: r.tx } : { status: 'refused', http: second.status, error: out.error };
    },
  };
}

/**
 * Run one task. `chat(messages, tools)` returns an OpenAI-style assistant
 * message; by default it calls NEAR AI Cloud.
 */
export async function runTask(task, { handlers, chat, maxSteps = 12, onEvent = () => {} }) {
  const messages = [{ role: 'system', content: SYSTEM }, { role: 'user', content: task }];
  for (let step = 0; step < maxSteps; step++) {
    const msg = await chat(messages, TOOLS);
    messages.push(msg);
    if (!msg.tool_calls?.length) return { summary: msg.content ?? '', messages };
    for (const call of msg.tool_calls) {
      let result;
      try {
        const args = JSON.parse(call.function.arguments || '{}');
        const h = handlers[call.function.name];
        result = h ? await h(args) : { error: `unknown tool ${call.function.name}` };
        onEvent({ tool: call.function.name, args, result });
      } catch (e) {
        result = { error: String(e.message ?? e).slice(0, 300) };
      }
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
    }
  }
  return { summary: 'Stopped: too many steps.', messages };
}

/** NEAR AI Cloud chat completions (OpenAI-compatible). */
export function nearAiChat({ apiKey, model, baseUrl = 'https://cloud-api.near.ai/v1', fetchImpl = fetch }) {
  return async (messages, tools) => {
    const r = await fetchImpl(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages, tools, tool_choice: 'auto' }),
    });
    if (!r.ok) throw new Error(`NEAR AI ${r.status}: ${(await r.text()).slice(0, 300)}`);
    return (await r.json()).choices[0].message;
  };
}
