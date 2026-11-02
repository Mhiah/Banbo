// One list of everything that happened, from authoritative contract state:
// payment requests (stored per request) and blocked attempts (ring buffer).
import { assetOf, type Asset, type VaultState, type Status, type PaymentOrigin } from './near';

export type Kind = 'blocked' | Status;

export interface ActivityItem {
  id: string;
  kind: Kind;
  at: number;
  agent: string;
  recipient: string;
  amount: string;
  asset: Asset;
  memo: string;
  requestId: string;
  key?: string;
  /** Why it was blocked, or why a payment failed. */
  reason?: string;
  /** Paid to a hidden-allowlist vendor. */
  hidden?: boolean;
  /** Origin labels, for payments under a task. */
  origin?: PaymentOrigin | null;
  /** Why a pending payment waits for the owner. */
  holdReason?: string | null;
  /** "tee" or "owner_vouched" */
  labelTrust?: string | null;
  raw: unknown;
}

export const STATUS: Record<Kind, { label: string; tone: 'red' | 'green' | 'amber' | 'blue' | 'gray'; help: string }> = {
  blocked: { label: 'Blocked', tone: 'red', help: 'Rejected by the contract before any funds were reserved.' },
  PendingApproval: { label: 'Needs approval', tone: 'amber', help: 'Waiting for you. Funds are reserved until you approve or decline.' },
  InFlight: { label: 'Sending', tone: 'blue', help: 'Funds reserved and transfer sent. Waiting for the network to confirm the result.' },
  Settled: { label: 'Paid', tone: 'green', help: 'Transfer confirmed. The reserved amount now counts as spent.' },
  Failed: { label: 'Failed · refunded', tone: 'amber', help: 'The transfer failed on-chain. The reservation was released exactly once and the funds returned to the vault.' },
  Declined: { label: 'Declined', tone: 'gray', help: 'You declined this payment. The reservation was released.' },
  Expired: { label: 'Expired', tone: 'gray', help: 'Nobody approved this payment in time, so it expired and its reservation was released. Nothing was sent.' },
};

export function activity(state: VaultState): ActivityItem[] {
  const items: ActivityItem[] = [
    ...state.blocked.map((b, i) => ({
      id: `b:${b.agent}:${b.request_id}:${b.at_ms}:${i}`,
      kind: 'blocked' as const,
      at: b.at_ms,
      agent: b.agent,
      recipient: b.recipient,
      amount: b.amount,
      asset: assetOf(state, b.token),
      memo: b.memo,
      requestId: b.request_id,
      reason: b.reason,
      origin: b.origin ?? null,
      raw: b,
    })),
    ...state.requests.map((r) => ({
      id: `r:${r.key}`,
      kind: r.status,
      at: r.created_at_ms,
      agent: r.agent,
      recipient: r.recipient,
      amount: r.amount,
      asset: assetOf(state, r.token),
      memo: r.memo,
      requestId: r.request_id,
      key: r.key,
      reason: r.failure_reason ?? undefined,
      hidden: !!r.recipient_fingerprint,
      origin: r.origin ?? null,
      holdReason: r.hold_reason ?? null,
      labelTrust: r.label_trust ?? null,
      raw: r,
    })),
  ];
  return items.sort((a, b) => b.at - a.at);
}
