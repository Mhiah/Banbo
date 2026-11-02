import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { KeyPair } from 'near-api-js';
import { keygen } from '../src/keygen.js';

test('keygen writes a private key only this user can read, and refuses to overwrite it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'banbo-keygen-'));
  const file = path.join(dir, 'sub', 'agent-key.json');
  const { publicKey } = keygen(file);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.public_key, publicKey);
  assert.equal(KeyPair.fromString(saved.private_key).getPublicKey().toString(), publicKey);
  assert.match(publicKey, /^ed25519:/);
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.throws(() => keygen(file), /already exists/);
});
