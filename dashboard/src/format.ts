export const YOCTO = 10n ** 24n;

/**
 * Smallest-unit string → display amount, rounded down. NEAR shows up to 3
 * decimals with trailing zeros trimmed ("1.5"); tokens such as USDC show
 * cents ("1.50").
 */
export function units(raw: string | bigint, decimals: number, digits = decimals === 24 ? 3 : Math.min(decimals, 2)): string {
  const fixed = decimals !== 24;
  const v = BigInt(raw);
  const one = 10n ** BigInt(decimals);
  const neg = v < 0n;
  const a = neg ? -v : v;
  const whole = a / one;
  const scale = 10n ** BigInt(digits);
  const frac = ((a % one) * scale) / one;
  const padded = frac.toString().padStart(digits, '0');
  const f = fixed ? (digits ? padded : '') : padded.replace(/0+$/, '');
  const s = `${whole.toLocaleString('en-US')}${f ? `.${f}` : ''}`;
  return neg ? `-${s}` : s;
}

/** yoctoNEAR string → "1.234". */
export const near = (yocto: string | bigint, digits = 3) => units(yocto, 24, digits);

/** "1.5" → smallest units for a token with `decimals`. Throws on malformed input. */
export function toUnits(input: string, decimals: number): string {
  const s = input.trim();
  const m = s.match(/^(\d+)(?:\.(\d+))?$/);
  if (!m || (m[2] ?? '').length > decimals) throw new Error(decimals ? `Enter an amount like 0.5 (up to ${decimals} decimals)` : 'Enter a whole number');
  return (BigInt(m[1]) * 10n ** BigInt(decimals) + BigInt((m[2] ?? '').padEnd(decimals, '0') || '0')).toString();
}

/** "1.5" NEAR → yoctoNEAR string. */
export const toYocto = (input: string) => toUnits(input, 24);

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
  token_not_supported: 'Token not accepted by this vault',
  token_not_enabled_for_agent: 'Agent has no limits for this token',
  recipient_not_registered: 'Recipient can’t receive this token yet',
  transfer_failed: 'Transfer failed',
  recipient_in_cooldown: 'Recipient was added too recently',
  exceeds_payment_rate: 'Too many payments this hour',
  memo_not_encrypted: 'Memo wasn’t encrypted',
  agent_not_attested: 'Agent isn’t a verified TEE agent',
  attestation_expired: 'Agent’s TEE attestation expired',
  agent_measurement_not_approved: 'Agent runs an image you no longer approve',
  too_many_open_payments: 'Too many payments waiting at once',
  reconciled_by_owner: 'Marked as not sent by the owner',
  origin_required: 'Payment had no origin labels',
  task_not_found: 'No such mandate',
  task_not_for_agent: 'Mandate belongs to another agent',
  task_closed: 'Mandate is closed',
  task_expired: 'Mandate has ended',
  task_token_mismatch: 'Wrong asset for this mandate',
  recipient_from_untrusted_source: 'Recipient came from a document, not from you',
  recipient_not_in_task: 'Recipient isn’t a payee of this mandate',
  exceeds_task_max_per_payment: 'Over the mandate’s per-payment limit',
  exceeds_task_budget: 'Over the mandate’s budget',
  amount_from_untrusted_source: 'Amount came from a source you don’t trust',
  over_approval_threshold: 'Over the agent’s approval threshold',
};

/** Where a labelled value came from, in words. */
export function originText(o: { kind: string; source?: string } | null | undefined): string {
  if (!o) return 'not labelled';
  if (o.kind === 'owner') return 'you (the owner)';
  const [kind, name] = (o.source ?? '').split(/:(.*)/s);
  if (kind === 'email') return name === 'unverified' ? 'an email that failed DKIM' : `an email from ${name} (DKIM verified)`;
  if (kind === 'web') return `the web page at ${name}`;
  if (kind === 'doc') return `the file ${name}`;
  return o.source ?? 'unknown';
}

/** 3_600_000 → "1 hour", 90_000 → "1.5 minutes", 0 → "Off". */
export function duration(ms: number): string {
  if (!ms) return 'Off';
  const fmt = (v: number, unit: string) => `${Number.isInteger(v) ? v : v.toFixed(1)} ${unit}${v === 1 ? '' : 's'}`;
  if (ms >= 86_400_000) return fmt(ms / 86_400_000, 'day');
  if (ms >= 3_600_000) return fmt(ms / 3_600_000, 'hour');
  if (ms >= 60_000) return fmt(ms / 60_000, 'minute');
  return fmt(ms / 1000, 'second');
}

/** Time left until `ms`, e.g. "in 42m". */
export function until(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((ms - now) / 1000));
  if (s < 60) return `in ${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `in ${m}m`;
  const h = Math.floor(m / 60);
  if (h >= 48) return `in ${Math.round(h / 24)}d`;
  return m % 60 ? `in ${h}h ${m % 60}m` : `in ${h}h`;
}
export const reasonText = (r: string) => REASONS[r] ?? r.replace(/_/g, ' ');

export const short = (id: string) => (id.length > 28 ? `${id.slice(0, 12)}…${id.slice(-12)}` : id);
