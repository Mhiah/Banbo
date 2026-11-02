// Decimal strings <-> integer units, exact (no floating point).

const DECIMAL = /^(\d{1,30})(?:\.(\d{1,30}))?$/;

/** "0.30" with 24 decimals -> "300000000000000000000000". Throws on bad input. */
export function parseUnits(text, decimals) {
  const m = DECIMAL.exec(String(text).trim());
  if (!m) throw new Error(`"${text}" is not a plain decimal number (use digits and one dot, like 0.25)`);
  const [, whole, frac = ''] = m;
  if (frac.length > decimals) throw new Error(`"${text}" has more than ${decimals} decimal places`);
  return (BigInt(whole) * 10n ** BigInt(decimals) + BigInt((frac + '0'.repeat(decimals)).slice(0, decimals) || '0')).toString();
}

/** "300000000000000000000000" with 24 decimals -> "0.3". */
export function formatUnits(units, decimals) {
  const v = BigInt(units);
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  const frac = (v % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole.toString();
}

/**
 * Every number written in a text, as units at the given decimals.
 * "1,250.00" counts as 1250. Numbers with more decimals than the token has
 * are skipped (they can't be this amount).
 */
export function amountsIn(text, decimals) {
  const out = new Set();
  for (const m of String(text).matchAll(/\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g)) {
    try { out.add(parseUnits(m[0].replace(/,/g, ''), decimals)); } catch { /* not a usable amount */ }
  }
  return out;
}
