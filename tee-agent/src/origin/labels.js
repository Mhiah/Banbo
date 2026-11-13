// Origin labels: where a value came from. This is the "capability" of a
// value in CaMeL ("Defeating Prompt Injections by Design", Debenedetti et
// al., Google, Google DeepMind and ETH Zurich, 2025), reduced to the one
// question the vault asks: did the owner set this, or did it come from
// content nobody vouched for?
import crypto from 'node:crypto';

export const OWNER = Object.freeze({ kind: 'owner' });

export const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');

/**
 * A label for a value taken from untrusted content. `identity` (optional)
 * names the document across copies of it; it never goes on-chain.
 */
export function fromSource(source, content, identity = null) {
  if (!/^(email|web|doc|api):[!-~]{1,94}$/.test(source)) throw new Error(`bad source ${source}`);
  const digest = sha256(content);
  return Object.freeze({ kind: 'source', source, digest, identity: identity ?? digest });
}

/**
 * The request id for a payment whose amount came from a document. It is the
 * same every time the same document is paid under the same task to the same
 * recipient, so the vault's exactly-once rule covers replays of an invoice.
 */
export const documentPaymentId = (prefix, taskId, origin, recipient) =>
  `${prefix}-${sha256(`${taskId}|${origin.identity ?? origin.digest}|${recipient}`).slice(0, 40)}`;

/** A value and its label. Values are never unwrapped without their label. */
export class Labeled {
  constructor(value, origin) {
    this.value = value;
    this.origin = origin;
    Object.freeze(this);
  }
}

/** A value derived from several inputs is only as trusted as the least trusted one. */
export function join(...origins) {
  return origins.find((o) => o.kind !== 'owner') ?? OWNER;
}

export const isOwner = (o) => o.kind === 'owner';

/** The JSON the contract expects for an Origin. */
export const toContract = (o) => (isOwner(o) ? { kind: 'owner' } : { kind: 'source', source: o.source, digest: o.digest });

export const describe = (o) => (isOwner(o) ? 'owner' : `${o.source} (sha256 ${o.digest.slice(0, 12)}…)`);
