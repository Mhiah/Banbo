// A pay-per-call API that only answers once a Banbo vault has paid it.
//
// The vendor holds no keys and trusts nobody's word: it quotes a price,
// and before serving it reads the vault contract over RPC to check that the
// payment for that exact quote has settled to the vendor's account.
//
//   GET /v1/forecast?city=Lisbon          -> 402 + quote (no payment yet)
//   GET /v1/forecast?city=Lisbon
//       x-banbo-payment: <agent>:<quote id> -> 200 + data (payment verified on-chain)
//
// A quote is bound to one path, one price and one use. The data is sample
// data from a demo vendor.
import http from 'node:http';
import crypto from 'node:crypto';

/** Price list in the token's smallest units (USDC: 6 decimals). */
export const CATALOG = {
  '/v1/forecast': { price: '250000', description: '3-day forecast for one city' },
  '/v1/history': { price: '1000000', description: '30 days of observed weather for one city' },
  '/v1/bulk-export': { price: '15000000', description: 'Every city, every day, as one file' },
};

const QUOTE_TTL_MS = 10 * 60_000;

async function rpcView(nodeUrl, contractId, method, args, finality) {
  const res = await fetch(nodeUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'query',
      params: {
        request_type: 'call_function', finality, account_id: contractId, method_name: method,
        args_base64: Buffer.from(JSON.stringify(args)).toString('base64'),
      },
    }),
  });
  const body = await res.json();
  if (body.error || body.result?.error) throw new Error(JSON.stringify(body.error ?? body.result.error));
  return JSON.parse(Buffer.from(body.result.result).toString('utf8'));
}

// Deterministic sample data so runs are reproducible.
function sample(path, city) {
  const seed = [...`${path}:${city}`].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
  const r = (i, lo, hi) => lo + ((seed >>> (i % 24)) % (hi - lo + 1));
  if (path === '/v1/forecast') {
    return { city, days: [0, 1, 2].map((d) => ({ day: d, high_c: r(d, 17, 29), low_c: r(d + 5, 9, 16), rain_pct: r(d + 9, 0, 70) })) };
  }
  if (path === '/v1/history') {
    return { city, days: 30, avg_high_c: r(1, 18, 26), avg_low_c: r(2, 10, 15), rainy_days: r(3, 1, 12) };
  }
  return { cities: 412, rows: 150_384, url: 'https://data.nimbus-weather.example/export.parquet' };
}

/**
 * Start the vendor API. Returns { url, port, close, stats }.
 * `finality` should be 'final' on testnet/mainnet; the sandbox uses 'optimistic'.
 */
export async function startPaidApi({ vendorId, vaultId, tokenId, symbol = 'USDC', nodeUrl, port = 0, finality = 'final', catalog = CATALOG }) {
  const quotes = new Map();
  const stats = { quoted: 0, served: 0, refused: 0 };

  const send = (res, code, body) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const refuse = (res, code, body) => { stats.refused += 1; send(res, code, body); };

  const server = http.createServer(async (req, res) => {
    try {
      const u = new URL(req.url, 'http://localhost');
      const item = catalog[u.pathname];
      if (req.method !== 'GET' || !item) return send(res, 404, { error: 'not_found' });
      const city = u.searchParams.get('city') ?? 'all';
      const proof = req.headers['x-banbo-payment'];

      if (!proof) {
        const id = `q-${crypto.randomBytes(6).toString('hex')}`;
        const quote = {
          id, path: u.pathname, price: item.price, token: tokenId, symbol, recipient: vendorId, vault: vaultId,
          memo: `API call: ${item.description}`, expires_at: Date.now() + QUOTE_TTL_MS,
        };
        quotes.set(id, { ...quote, redeemed: false });
        stats.quoted += 1;
        return send(res, 402, {
          error: 'payment_required',
          how: `Pay through the Banbo vault ${vaultId}: request_payment with request_id = quote.id, then retry with header x-banbo-payment: <your agent account>:<quote.id>`,
          quote,
        });
      }

      const [agent, quoteId] = String(proof).split(':');
      const q = quotes.get(quoteId);
      if (!agent || !q) return refuse(res, 402, { error: 'unknown_quote' });
      if (q.path !== u.pathname) return refuse(res, 402, { error: 'quote_is_for_another_endpoint' });
      if (q.redeemed) return refuse(res, 409, { error: 'quote_already_redeemed' });
      if (Date.now() > q.expires_at) return refuse(res, 402, { error: 'quote_expired' });

      // The only thing the vendor trusts: the vault contract's own record.
      const pay = await rpcView(nodeUrl, vaultId, 'get_request', { key: `${agent}:${quoteId}` }, finality);
      if (!pay) return refuse(res, 402, { error: 'payment_not_found' });
      if (pay.status !== 'Settled') return refuse(res, 402, { error: 'payment_not_settled', status: pay.status });
      if (pay.recipient !== vendorId || pay.request_id !== quoteId) return refuse(res, 402, { error: 'payment_does_not_match_quote' });
      if ((pay.token ?? null) !== (tokenId ?? null) || BigInt(pay.amount) < BigInt(q.price)) {
        return refuse(res, 402, { error: 'payment_does_not_match_quote' });
      }

      q.redeemed = true;
      stats.served += 1;
      return send(res, 200, { paid: { key: pay.key, amount: pay.amount, token: pay.token }, data: sample(u.pathname, city) });
    } catch (e) {
      send(res, 500, { error: String(e.message ?? e).slice(0, 300) });
    }
  });

  await new Promise((ok) => server.listen(port, '127.0.0.1', ok));
  const actual = server.address().port;
  return {
    url: `http://127.0.0.1:${actual}`,
    port: actual,
    stats,
    close: () => new Promise((ok) => server.close(ok)),
  };
}

/**
 * The agent side: call a paid endpoint, paying the quote through the vault
 * when asked. `pay({ requestId, recipient, amountUnits, token, memo })` must
 * call request_payment and return the vault's outcome.
 *
 * Returns { status: 'ok', data, quote, outcome } on success, or
 * { status: 'blocked' | 'pending_approval' | 'refused', ... } otherwise.
 */
export async function paidFetch(url, { agentId, vaultId, pay, fetchImpl = fetch }) {
  const first = await fetchImpl(url);
  if (first.status === 200) return { status: 'ok', data: (await first.json()).data };
  const body = await first.json();
  if (first.status !== 402 || !body.quote) return { status: 'refused', http: first.status, error: body.error };
  const quote = body.quote;
  // The agent only ever pays through its own vault; the contract decides the rest.
  if (quote.vault !== vaultId) return { status: 'refused', error: 'quote_for_another_vault', quote };

  const outcome = await pay({
    requestId: quote.id, recipient: quote.recipient, amountUnits: quote.price, token: quote.token, memo: quote.memo,
  });
  if (outcome.outcome === 'rejected') return { status: 'blocked', reason: outcome.reason, quote, outcome };
  if (outcome.outcome === 'pending_approval') return { status: 'pending_approval', quote, outcome };

  const second = await fetchImpl(url, { headers: { 'x-banbo-payment': `${agentId}:${quote.id}` } });
  const out = await second.json();
  if (second.status !== 200) return { status: 'refused', http: second.status, error: out.error, quote, outcome };
  return { status: 'ok', data: out.data, quote, outcome, paid: out.paid };
}
