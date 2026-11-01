// Private-mode helpers. Kept identical to demo/src/privacy.js; the tests check
// the same vectors as the dashboard and the contract.
//
//  - Memos are sealed to the owner's X25519 key: a fresh key pair per memo,
//    NaCl box (X25519 + XSalsa20-Poly1305), sent as "enc1:" + base64 of
//    ephemeral public key (32) || nonce (24) || ciphertext. Only the owner's
//    secret key opens it.
//  - Hidden allowlist entries are sha256("banbo-recipient-v1:<account>:<salt>")
//    with a random 32-byte salt per recipient.
import crypto from 'node:crypto';
import nacl from 'tweetnacl';

export const ENC_PREFIX = 'enc1:';
export const KEY_PREFIX = 'x25519:';
const KEY_DOMAIN = 'banbo-owner-key-v1';

const hex = (u8) => Buffer.from(u8).toString('hex');
const unhex = (s) => new Uint8Array(Buffer.from(s, 'hex'));

/** Owner key pair from a 32-byte seed. */
export function keyPairFromSeed(seed) {
  const kp = nacl.box.keyPair.fromSecretKey(new Uint8Array(seed));
  return { publicKey: `${KEY_PREFIX}${hex(kp.publicKey)}`, secretKey: kp.secretKey };
}

/** Same derivation the dashboard uses after the owner signs the unlock message. */
export function keyPairFromSignature(signature) {
  const seed = crypto.createHash('sha256').update(KEY_DOMAIN).update(Buffer.from(signature)).digest();
  return keyPairFromSeed(seed);
}

/** Passphrase fallback, for wallets that can't sign messages. */
export function keyPairFromPassphrase(passphrase, vaultId) {
  const seed = crypto.pbkdf2Sync(passphrase, `${KEY_DOMAIN}:${vaultId}`, 600_000, 32, 'sha256');
  return keyPairFromSeed(seed);
}

/** Seal a UTF-8 string to "x25519:<hex>". */
export function seal(plaintext, ownerKey) {
  if (!ownerKey?.startsWith(KEY_PREFIX)) throw new Error('owner key must be x25519:<hex>');
  const pub = unhex(ownerKey.slice(KEY_PREFIX.length));
  const eph = nacl.box.keyPair();
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const ct = nacl.box(new TextEncoder().encode(plaintext), nonce, pub, eph.secretKey);
  const out = new Uint8Array(32 + 24 + ct.length);
  out.set(eph.publicKey, 0);
  out.set(nonce, 32);
  out.set(ct, 56);
  return ENC_PREFIX + Buffer.from(out).toString('base64');
}

/** Open an "enc1:" string with the owner's secret key, or return null. */
export function open(sealed, secretKey) {
  if (typeof sealed !== 'string' || !sealed.startsWith(ENC_PREFIX)) return null;
  const raw = new Uint8Array(Buffer.from(sealed.slice(ENC_PREFIX.length), 'base64'));
  if (raw.length < 56 + nacl.box.overheadLength) return null;
  const pt = nacl.box.open(raw.subarray(56), raw.subarray(32, 56), raw.subarray(0, 32), secretKey);
  return pt ? new TextDecoder().decode(pt) : null;
}

export const isSealed = (s) => typeof s === 'string' && s.startsWith(ENC_PREFIX);

export function newSalt() {
  return hex(nacl.randomBytes(32));
}

export function recipientFingerprint(account, salt) {
  if (!/^[0-9a-f]{64}$/.test(salt)) throw new Error('salt must be 32 bytes of lowercase hex');
  return crypto.createHash('sha256').update(`banbo-recipient-v1:${account}:${salt}`).digest('hex');
}

/**
 * Everything needed to add a hidden recipient: the fingerprint for the
 * contract, a label only the owner can read, and the salt the agent needs.
 */
export function hiddenEntry(account, ownerKey, note = '') {
  const salt = newSalt();
  return {
    account,
    salt,
    fingerprint: recipientFingerprint(account, salt),
    label: seal(JSON.stringify({ account, salt, note }), ownerKey),
  };
}
