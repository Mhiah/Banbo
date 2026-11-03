// The factory creates a vault in one transaction: new account, funds, a copy
// of the Banbo contract it stores, and init with the caller as owner. Runs on
// a local NEAR node.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pkg from 'near-workspaces';
import { N } from '../src/vault.js';

const { Worker } = pkg;
const res = (f) => fileURLToPath(new URL(`../../contract/res/${f}`, import.meta.url));
const VAULT_WASM = fs.readFileSync(res('banbo.wasm'));
const FACTORY_WASM = fs.readFileSync(res('banbo_factory.wasm'));
const DAY_MS = 86_400_000;
const bs58 = (buf) => {
  const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = BigInt('0x' + buf.toString('hex')), s = '';
  while (n > 0n) { s = A[Number(n % 58n)] + s; n /= 58n; }
  for (const b of buf) { if (b !== 0) break; s = '1' + s; }
  return s;
};
const HASH = bs58(crypto.createHash('sha256').update(VAULT_WASM).digest());

let worker, root, factory, alice, mallory;
before(async () => {
  worker = await Worker.init();
  root = worker.rootAccount;
  // The factory pays to store one copy of the vault code (~7.7 NEAR).
  factory = await root.createSubAccount('factory', { initialBalance: N(20) });
  alice = await root.createSubAccount('alice', { initialBalance: N(20) });
  mallory = await root.createSubAccount('mallory', { initialBalance: N(20) });
  await factory.deploy(FACTORY_WASM);
  await factory.call(factory, 'new', { owner: factory.accountId });
});
after(async () => { await worker?.tearDown(); });

test('only the owner can set the vault code, and setting it records its hash', async () => {
  await assert.rejects(mallory.call(factory, 'set_vault_code', VAULT_WASM, { gas: '300000000000000' }), /only the factory owner/);
  const r = await factory.callRaw(factory, 'set_vault_code', VAULT_WASM, { gas: '300000000000000' });
  assert.ok(r.succeeded, JSON.stringify(r.result?.status));
  const info = await factory.view('get_info', {});
  assert.equal(info.vault_code_hash, HASH);
});

test('create_vault: one transaction gives the caller an initialized vault running the stored code', async () => {
  const r = await alice.callRaw(factory, 'create_vault', { name: 'acme', period_ms: DAY_MS, shared_cap: N(5) },
    { attachedDeposit: N(10), gas: '300000000000000' });
  assert.ok(r.succeeded, JSON.stringify(r.result?.status));
  const vaultId = `acme.${factory.accountId}`;
  const vault = root.getAccount(vaultId);
  const cfg = await vault.view('get_config', {});
  assert.equal(cfg.owner, alice.accountId);
  const state = await worker.provider.viewAccount(vaultId);
  assert.equal(state.code_hash, HASH);
  // No access key: nobody can redeploy the vault's code.
  const keys = await worker.provider.query({ request_type: 'view_access_key_list', account_id: vaultId, finality: 'final' });
  assert.equal(keys.keys.length, 0);
  // The owner can use it straight away.
  await alice.call(vault, 'allow_recipient', { recipient: mallory.accountId });
  assert.deepEqual(await vault.view('list_allowlist', {}), [mallory.accountId]);
  assert.equal((await factory.view('get_info', {})).vaults_created, 1);
});

test('a taken name refunds the deposit; a stranger cannot re-initialize a vault', async () => {
  const before = BigInt((await mallory.balance()).total.toString());
  const r = await mallory.callRaw(factory, 'create_vault', { name: 'acme', period_ms: DAY_MS, shared_cap: N(5) },
    { attachedDeposit: N(10), gas: '300000000000000' });
  assert.ok(r.logs.some((l) => l.includes('not created')), r.logs.join('\n'));
  const after = BigInt((await mallory.balance()).total.toString());
  assert.ok(before - after < BigInt(N(0.1)), `lost ${before - after} yocto`);
  const vault = root.getAccount(`acme.${factory.accountId}`);
  await assert.rejects(mallory.call(vault, 'new', { owner: mallory.accountId, period_ms: DAY_MS, shared_cap: N(5) }));
  assert.equal((await vault.view('get_config', {})).owner, alice.accountId);
});

test('create_vault rejects a bad name or too small a deposit', async () => {
  await assert.rejects(alice.call(factory, 'create_vault', { name: 'Bad.Name', period_ms: DAY_MS, shared_cap: N(5) },
    { attachedDeposit: N(10), gas: '300000000000000' }), /vault name/);
  await assert.rejects(alice.call(factory, 'create_vault', { name: 'tiny', period_ms: DAY_MS, shared_cap: N(5) },
    { attachedDeposit: N(5), gas: '300000000000000' }), /attach at least/);
});
