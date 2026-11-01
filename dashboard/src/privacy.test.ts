import { describe, expect, it } from 'vitest';
import {
  keyPairFromPassphrase, keyPairFromSignature, recipientFingerprint, seal, open, readLabel, hiddenEntry, isSealed,
} from './privacy';

// Produced by demo/src/privacy.js (Node), so the agents, the contract and
// the dashboard agree byte for byte. The contract test checks the same fingerprint.
const V = {
  pass: 'x25519:78540f435d8cae6c85681c7c02871ee89045b8833b8feb2186393cebd683fd3b',
  sig: 'x25519:c58575e34526ef4336e9cbd8de0c8fec9b614a985b1c41cadde5990b2387b306',
  salt: '5ab1e5a1'.repeat(8),
  fp: 'f9ae7fcae4957690fa095cf6a61488e15fb351d612b6a3e343a8f946fd2af7b8',
  sealed: 'enc1:kkTiXa5nriEbY3lBIOk9hs3auQToJ1OrBTTlRmU4FSDyEbgOkl2WfcXfKRTloFVom1rPjJSH1Jm6RmPRz+9oi7+lES+5AwnURTtQvwCLVh1okZYBWjOzYZ/ZDvqTbqRasDiCiTyX3Q==',
  label: 'enc1:qyWRXCU+fDIlnuUNsvCtFanaO4lK5CkUoyvFKUrerXLJiEzQiZaFv4CjugSqRJnJcGNipITcz8p/htRBPVUNxO8ESDI+MSo/wKZ4eJ4cfVTkBkx2qu1taf4BUhygrI7E4rPgf/vtooDTe9fmkil9FjlanPKv49+s2lXu6xWXwxvrQ7jzv8UCdI2Qu+n6bXladEh7Yqre7e2spcDp0ZwYbM34eRFiE8SXDRoBddfbcGzA+2iIVAi34XmMGsw=',
};

describe('private mode crypto', () => {
  it('derives the same owner keys as the agents', async () => {
    expect((await keyPairFromPassphrase('banbo sandbox demo', 'vault.test.near')).publicKey).toBe(V.pass);
    expect((await keyPairFromSignature(new Uint8Array(64).fill(7))).publicKey).toBe(V.sig);
  });

  it('computes the contract fingerprint', async () => {
    expect(await recipientFingerprint('quiet-vendor.near', V.salt)).toBe(V.fp);
    await expect(recipientFingerprint('x.near', 'ABC')).rejects.toThrow();
  });

  it('opens memos sealed by an agent, and only with the right key', async () => {
    const k = await keyPairFromPassphrase('banbo sandbox demo', 'vault.test.near');
    expect(open(V.sealed, k.secretKey)).toBe('Private dataset, November batch');
    const other = await keyPairFromPassphrase('wrong', 'vault.test.near');
    expect(open(V.sealed, other.secretKey)).toBeNull();
    expect(open('enc1:not-base64!!', k.secretKey)).toBeNull();
    expect(open('plain memo', k.secretKey)).toBeNull();
  });

  it('round-trips its own sealing with a fresh key per memo', async () => {
    const k = await keyPairFromPassphrase('p', 'v.near');
    const a = seal('hello', k.publicKey), b = seal('hello', k.publicKey);
    expect(isSealed(a)).toBe(true);
    expect(a).not.toBe(b);
    expect(open(a, k.secretKey)).toBe('hello');
    expect(a.length).toBeLessThanOrEqual(512);
  });

  it('reads hidden-recipient labels and rejects one that does not match its fingerprint', async () => {
    const k = await keyPairFromPassphrase('banbo sandbox demo', 'vault.test.near');
    expect(await readLabel(V.fp, V.label, k.secretKey)).toEqual({ account: 'quiet-vendor.near', salt: V.salt, note: 'n' });
    expect(await readLabel('00'.repeat(32), V.label, k.secretKey)).toBeNull();
    const e = await hiddenEntry('vendor.near', k.publicKey, 'note');
    expect(await readLabel(e.fingerprint, e.label, k.secretKey)).toEqual({ account: 'vendor.near', salt: e.salt, note: 'note' });
  });
});
