// Model adapters. Both the planner and the reader only need text in, text out.

/** NEAR AI Cloud (OpenAI-compatible; models run in TEEs). */
export function nearAiLlm({ apiKey, model, baseUrl = 'https://cloud-api.near.ai/v1', fetchImpl = fetch }) {
  return {
    name: `near-ai:${model}`,
    async complete({ system, prompt, maxTokens = 1000 }) {
      const r = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, max_tokens: maxTokens, messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }] }),
      });
      if (!r.ok) throw new Error(`NEAR AI ${r.status}: ${(await r.text()).slice(0, 300)}`);
      return (await r.json()).choices[0].message.content ?? '';
    },
  };
}

/** Claude through an Anthropic SDK client (the sandbox demo uses this). */
export function anthropicLlm({ client, model }) {
  return {
    name: `anthropic:${model}`,
    async complete({ system, prompt, maxTokens = 1000 }) {
      const msg = await client.messages.create({ model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: prompt }] });
      return msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    },
  };
}
