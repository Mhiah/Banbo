export const YOCTO = 10n ** 24n;

/** yoctoNEAR string → "1.234" (rounded down, up to `digits` decimals, trailing zeros trimmed). */
export function near(yocto: string | bigint, digits = 3): string {
  const v = BigInt(yocto);
  const neg = v < 0n;
  const a = neg ? -v : v;
  const whole = a / YOCTO;
  const scale = 10n ** BigInt(digits);
  const frac = ((a % YOCTO) * scale) / YOCTO;
  let f = frac.toString().padStart(digits, '0').replace(/0+$/, '');
  const s = `${whole.toLocaleString('en-US')}${f ? `.${f}` : ''}`;
  return neg ? `-${s}` : s;
}

/** "1.5" NEAR → yoctoNEAR string. Throws on malformed input. */
export function toYocto(input: string): string {
  const s = input.trim();
  if (!/^\d+(\.\d{1,24})?$/.test(s)) throw new Error('Enter an amount like 0.5');
  const [w, f = ''] = s.split('.');
  return (BigInt(w) * YOCTO + BigInt(f.padEnd(24, '0'))).toString();
}

export function pct(part: string | bigint, whole: string | bigint): number {
  const w = BigInt(whole);
  if (w === 0n) return 0;
  return Math.min(100, Number((BigInt(part) * 10000n) / w) / 100);
}

export function ago(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return new Date(ms).toLocaleDateString();
}

const REASONS: Record<string, string> = {
  recipient_not_allowlisted: 'Recipient not on the allowlist',
  exceeds_per_request_max: 'Over the per-payment limit',
  exceeds_agent_period_limit: "Over this agent's daily limit",
  exceeds_shared_cap: 'Over the shared daily cap',
  insufficient_vault_balance: 'Not enough funds in the vault',
  agent_disabled: 'Agent is disabled',
  vault_paused: 'Vault is paused',
  unknown_agent: 'Not a registered agent',
  recipient_not_allowed: 'Agent tried to pay itself or the vault',
  zero_amount: 'Zero amount',
};
export const reasonText = (r: string) => REASONS[r] ?? r.replace(/_/g, ' ');

export const short = (id: string) => (id.length > 28 ? `${id.slice(0, 12)}…${id.slice(-12)}` : id);
