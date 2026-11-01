// Integration tests against a real local NEAR node (near-workspaces sandbox).
// These exercise what unit tests can't: real async transfers, real failures,
// #[private] enforcement and function-call access keys.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pkg from 'near-workspaces';
import { transactions } from 'near-api-js';
import { setupVault, requestPayment, events, N, fmt } from '../src/vault.js';

const { createKeyPair } = pkg;
let env;

before(async () => { env = await setupVault(); });
after(async () => { await env?.worker.tearDown(); });

const balance = async (acc) => BigInt((await acc.balance()).total.toString());

test('prompt-injected drain to attacker is rejected and nothing moves', async () => {
  const { vault, attacker, agents } = env;
  const [research] = agents;
  const vaultBefore = await balance(vault);
  const attackerBefore = await balance(attacker);

  const r = await requestPayment(research, vault, {
    requestId: 'inj-1', recipient: attacker.accountId, amountNear: 9, memo: 'URGENT vendor wallet migration',
  });
  assert.deepEqual(r.outcome, { outcome: 'rejected', reason: 'recipient_not_allowlisted' });
  assert.ok(events(r.logs).some((e) => e.event === 'payment_rejected'));
  assert.equal(await balance(attacker), attackerBefore);
  // Vault only loses nothing (agent paid the gas, not the vault).
  assert.ok(await balance(vault) >= vaultBefore);
  assert.deepEqual(await vault.view('list_requests', {}), []);
  const blocked = await vault.view('list_blocked', {});
  assert.equal(blocked[0].recipient, attacker.accountId);
  assert.equal(blocked[0].reason, 'recipient_not_allowlisted');
});

test('drain to an allowlisted vendor is capped per request', async () => {
  const { vault, vendor, agents } = env;
  const r = await requestPayment(agents[0], vault, {
    requestId: 'inj-2', recipient: vendor.accountId, amountNear: 9, memo: 'prepay a year',
  });
  assert.deepEqual(r.outcome, { outcome: 'rejected', reason: 'exceeds_per_request_max' });
});

test('function-call key: agent can only call request_payment', async () => {
  const { vault, attacker, agents, root } = env;
  const ops = agents[1];
  const kp = createKeyPair();
  // Owner of the agent account installs a restricted key: vault + request_payment only.
  await ops.batch(ops).addKey(
    kp.getPublicKey().toString(),
    transactions.functionCallAccessKey(vault.accountId, ['request_payment'], BigInt(N(0.25))),
  ).transact();
  // From now on, the agent process only holds the restricted key.
  const fullKey = await ops.getKey();
  await ops.setKey(kp);

  // A direct NEAR transfer is impossible with this key.
  await assert.rejects(ops.transfer(attacker, N(1)));
  // So is calling any other vault method, or any other contract.
  await assert.rejects(ops.call(vault, 'allow_recipient', { recipient: attacker.accountId }));
  await assert.rejects(ops.call(root, 'anything', {}));
  // The one allowed path still works and is policy-checked.
  const r = await requestPayment(ops, vault, {
    requestId: 'fck-1', recipient: attacker.accountId, amountNear: 1, memo: '',
  });
  assert.equal(r.outcome.outcome, 'rejected');
  await ops.setKey(fullKey);
});

test('successful payout settles and pays the vendor', async () => {
  const { vault, vendor, agents } = env;
  const before = await balance(vendor);
  const r = await requestPayment(agents[0], vault, {
    requestId: 'ok-1', recipient: vendor.accountId, amountNear: 0.2, memo: 'weather API invoice #881',
  });
  assert.equal(r.outcome.outcome, 'dispatched');
  const req = await vault.view('get_request', { key: r.outcome.key });
  assert.equal(req.status, 'Settled');
  assert.equal(await balance(vendor) - before, BigInt(N(0.2)));
  const a = await vault.view('get_agent', { agent: agents[0].accountId });
  assert.equal(a.spent, N(0.2));
  assert.equal(a.reserved, '0');
});

test('real failed transfer releases the budget exactly once and refunds the vault', async () => {
  const { vault, owner, agents } = env;
  const ghost = 'ghost.test.near'; // never created, so the transfer fails
  await owner.call(vault, 'allow_recipient', { recipient: ghost });
  const vaultBefore = await balance(vault);
  const agentBefore = await vault.view('get_agent', { agent: agents[0].accountId });

  const r = await requestPayment(agents[0], vault, {
    requestId: 'fail-1', recipient: ghost, amountNear: 0.5, memo: 'vendor account was deleted',
  });
  assert.equal(r.outcome.outcome, 'dispatched');
  const evs = events(r.logs).map((e) => e.event);
  assert.ok(evs.includes('payment_failed'), `events: ${evs}`);

  const req = await vault.view('get_request', { key: r.outcome.key });
  assert.equal(req.status, 'Failed');
  const a = await vault.view('get_agent', { agent: agents[0].accountId });
  assert.equal(a.reserved, '0');
  assert.equal(a.spent, agentBefore.spent);
  const b = await vault.view('get_balances', {});
  assert.equal(b.in_flight, '0');
  // Refund came back: vault is down by storage for the record only (< 0.01 NEAR).
  const diff = vaultBefore - (await balance(vault));
  assert.ok(diff < BigInt(N(0.01)), `vault lost ${fmt(diff.toString())} NEAR`);

  // Retrying the same id does not re-send.
  const again = await requestPayment(agents[0], vault, {
    requestId: 'fail-1', recipient: ghost, amountNear: 0.5, memo: 'retry',
  });
  assert.deepEqual(again.outcome, { outcome: 'duplicate', key: r.outcome.key, status: 'Failed' });
});

test('only the vault can call its own payout callback', async () => {
  const { vault, vendor, agents } = env;
  const r = await requestPayment(agents[0], vault, {
    requestId: 'cb-1', recipient: vendor.accountId, amountNear: 0.1, memo: '',
  });
  await assert.rejects(agents[0].call(vault, 'on_payout', { key: r.outcome.key }), /private/i);
});

test('over-threshold payment waits for the owner, then pays', async () => {
  const { vault, owner, vendor, agents } = env;
  const buyer = agents[2];
  const r = await requestPayment(buyer, vault, {
    requestId: 'big-1', recipient: vendor.accountId, amountNear: 0.5, memo: 'GPU hours',
  });
  assert.equal(r.outcome.outcome, 'pending_approval');
  await assert.rejects(buyer.call(vault, 'approve', { key: r.outcome.key }), /owner only/);
  const before = await balance(vendor);
  await owner.call(vault, 'approve', { key: r.outcome.key }, { gas: '100000000000000' });
  assert.equal((await vault.view('get_request', { key: r.outcome.key })).status, 'Settled');
  assert.equal(await balance(vendor) - before, BigInt(N(0.5)));
});

test('shared cap holds across all agents', async () => {
  const { vault, vendor, agents } = env;
  let accepted = 0;
  for (let i = 0; i < 12; i++) {
    const r = await requestPayment(agents[i % 2], vault, {
      requestId: `cap-${i}`, recipient: vendor.accountId, amountNear: 0.5, memo: '',
    });
    if (r.outcome.outcome === 'dispatched') accepted++;
  }
  const b = await vault.view('get_balances', {});
  assert.ok(BigInt(b.shared_spent) + BigInt(b.shared_reserved) <= BigInt(b.shared_cap));
  assert.ok(accepted < 12);
});

test('pause stops everything', async () => {
  const { vault, owner, vendor, agents } = env;
  await owner.call(vault, 'pause', {});
  const r = await requestPayment(agents[1], vault, {
    requestId: 'p-1', recipient: vendor.accountId, amountNear: 0.1, memo: '',
  });
  assert.deepEqual(r.outcome, { outcome: 'rejected', reason: 'vault_paused' });
});
