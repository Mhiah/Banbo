#!/usr/bin/env node
// Confidential Intents feasibility check. Asks NEAR Intents' 1Click API for a
// *dry* confidential quote (no deposit address is issued, nothing is spent)
// for the kind of payment a Banbo vault makes: USDC on NEAR to a vendor.
//
//   node scripts/confidential-intents-check.mjs [vendor.near] [amount_usdc]
//   ONECLICK_API_KEY=... (optional; avoids the unauthenticated fee in quotes)
//
// Mainnet only: NEAR Intents has no testnet. A dry quote moves no funds.
const BASE = process.env.ONECLICK_BASE || 'https://1click.chaindefuser.com';
const recipient = process.argv[2] || 'banbo-demo.near';
const amountUsdc = Number(process.argv[3] || '1');
const headers = { 'content-type': 'application/json' };
if (process.env.ONECLICK_API_KEY) headers['x-api-key'] = process.env.ONECLICK_API_KEY;

const tokens = await (await fetch(`${BASE}/v0/tokens`, { headers })).json();
const usdcNear = tokens.find((t) => t.blockchain === 'near' && t.symbol === 'USDC');
const usdcBase = tokens.find((t) => t.blockchain === 'base' && t.symbol === 'USDC');
if (!usdcNear) throw new Error('USDC on NEAR is not listed by 1Click');
console.log(`USDC on NEAR: ${usdcNear.assetId}  (contract ${usdcNear.contractAddress ?? '-'})`);

async function quote(label, body) {
  const r = await fetch(`${BASE}/v0/quote`, { method: 'POST', headers, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  console.log(`\n${label}: HTTP ${r.status}`);
  if (!r.ok) { console.log(`  ${j.message ?? JSON.stringify(j).slice(0, 300)}`); return null; }
  const q = j.quote ?? {};
  console.log(`  in ${q.amountInFormatted} → out ${q.amountOutFormatted}  (~${q.timeEstimate}s)`);
  console.log(`  deposit address issued: ${q.depositAddress ? 'yes' : 'no (dry run)'}`);
  console.log(`  quote signed by 1Click: ${j.signature ? j.signature.slice(0, 24) + '…' : 'no'}`);
  return j;
}

const base = {
  dry: true,
  swapType: 'EXACT_INPUT',
  slippageTolerance: 100,
  originAsset: usdcNear.assetId,
  depositType: 'ORIGIN_CHAIN',
  amount: String(Math.round(amountUsdc * 10 ** usdcNear.decimals)),
  refundTo: recipient,
  refundType: 'ORIGIN_CHAIN',
  recipient,
  recipientType: 'DESTINATION_CHAIN',
  deadline: new Date(Date.now() + 15 * 60_000).toISOString(),
};

await quote('Confidential USDC (NEAR) → USDC (NEAR)', { ...base, destinationAsset: usdcNear.assetId, confidentiality: 'basic' });
if (usdcBase) {
  await quote('Confidential USDC (NEAR) → USDC (Base)', {
    ...base, destinationAsset: usdcBase.assetId, recipient: '0x000000000000000000000000000000000000dEaD', confidentiality: 'basic',
  });
}

console.log(`
What this means for Banbo (see docs/PRIVACY.md):
  The vault would pay a per-quote deposit address, and the final recipient is
  set in the off-chain quote request. The contract can't check where the money
  ends up, so routing agent payouts this way would bypass the allowlist.
  Banbo keeps agent payouts on public, contract-enforced transfers.`);
