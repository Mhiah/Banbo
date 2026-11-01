// Private mode in the browser. Same formats as demo/src/privacy.js; the
// test vectors in privacy.test.ts were produced by that file.
//
// The owner's X25519 secret key is derived when the owner unlocks private
// mode (by signing a fixed message with their wallet, or from a passphrase)
// and kept in memory only. It is never stored or sent anywhere.
import nacl from 'tweetnacl';

export const ENC_PREFIX = 'enc1:';
export const KEY_PREFIX = 'x25519:';
const KEY_DOMAIN = 'banbo-owner-key-v1';

export interface OwnerKeys {
  publicKey: string;
  secretKey: Uint8Array;
}

const enc = new TextEncoder();
const hex = (u8: Uint8Array) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');
const unhex = (s: string) => new Uint8Array((s.match(/../g) ?? []).map((h) => parseInt(h, 16)));
const toB64 = (u8: Uint8Array) => btoa(String.fromCharCode(...u8));
const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function sha256(...parts: Uint8Array[]): Promise<Uint8Array> {
  const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { all.set(p, o); o += p.length; }
  return new Uint8Array(await crypto.subtle.digest('SHA-256', all));
}

export function keyPairFromSeed(seed: Uint8Array): OwnerKeys {
  const kp = nacl.box.keyPair.fromSecretKey(seed);
  return { publicKey: `${KEY_PREFIX}${hex(kp.publicKey)}`, secretKey: kp.secretKey };
}

/** From the bytes of the owner's NEP-413 signature over the unlock message. */
export async function keyPairFromSignature(signature: Uint8Array): Promise<OwnerKeys> {
  return keyPairFromSeed(await sha256(enc.encode(KEY_DOMAIN), signature));
}

export async function keyPairFromPassphrase(passphrase: string, vaultId: string): Promise<OwnerKeys> {
  const base = await crypto.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(`${KEY_DOMAIN}:${vaultId}`), iterations: 600_000 },
    base,
    256,
  );
  return keyPairFromSeed(new Uint8Array(bits));
}

/** What the owner signs to unlock. Fixed per vault, so the key is stable. */
export function unlockMessage(vaultId: string) {
  return {
    message: `Unlock Banbo private mode for vault ${vaultId}. This signature only derives your private-mode key on this device; it does not authorize any transaction.`,
    recipient: vaultId,
  };
}

/** NEP-413 needs a 32-byte nonce; ours is fixed per vault so the signature is too. */
export async function unlockNonce(vaultId: string): Promise<Uint8Array> {
  return sha256(enc.encode(`${KEY_DOMAIN}:nonce:${vaultId}`));
}

export function seal(plaintext: string, ownerKey: string): string {
  if (!ownerKey.startsWith(KEY_PREFIX)) throw new Error('owner key must be x25519:<hex>');
  const pub = unhex(ownerKey.slice(KEY_PREFIX.length));
  const eph = nacl.box.keyPair();
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const ct = nacl.box(enc.encode(plaintext), nonce, pub, eph.secretKey);
  const out = new Uint8Array(56 + ct.length);
  out.set(eph.publicKey, 0);
  out.set(nonce, 32);
  out.set(ct, 56);
  return ENC_PREFIX + toB64(out);
}

export function open(sealed: string, secretKey: Uint8Array): string | null {
  if (!isSealed(sealed)) return null;
  let raw: Uint8Array;
  try { raw = fromB64(sealed.slice(ENC_PREFIX.length)); } catch { return null; }
  if (raw.length < 56 + nacl.box.overheadLength) return null;
  const pt = nacl.box.open(raw.subarray(56), raw.subarray(32, 56), raw.subarray(0, 32), secretKey);
  return pt ? new TextDecoder().decode(pt) : null;
}

export const isSealed = (s: string | null | undefined): s is string => typeof s === 'string' && s.startsWith(ENC_PREFIX);

export const newSalt = () => hex(nacl.randomBytes(32));

export async function recipientFingerprint(account: string, salt: string): Promise<string> {
  if (!/^[0-9a-f]{64}$/.test(salt)) throw new Error('salt must be 32 bytes of lowercase hex');
  return hex(await sha256(enc.encode(`banbo-recipient-v1:${account}:${salt}`)));
}

export interface HiddenLabel {
  account: string;
  salt: string;
  note: string;
}

export async function hiddenEntry(account: string, ownerKey: string, note = '') {
  const salt = newSalt();
  return {
    account,
    salt,
    fingerprint: await recipientFingerprint(account, salt),
    label: seal(JSON.stringify({ account, salt, note }), ownerKey),
  };
}

/**
 * Open a hidden entry's label and check it really belongs to that
 * fingerprint (so a tampered label can't show the owner a wrong name).
 */
export async function readLabel(fingerprint: string, label: string | null, secretKey: Uint8Array): Promise<HiddenLabel | null> {
  if (!label) return null;
  const text = open(label, secretKey);
  if (!text) return null;
  try {
    const l = JSON.parse(text) as HiddenLabel;
    if ((await recipientFingerprint(l.account, l.salt)) !== fingerprint) return null;
    return { account: l.account, salt: l.salt, note: l.note ?? '' };
  } catch {
    return null;
  }
}

export function base64ToBytes(s: string): Uint8Array {
  return fromB64(s);
}
