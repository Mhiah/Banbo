import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { verify as dcapVerify } from '@phala/dcap-qvl';
import { agentKeyFromMaterial, reportData, tcbInfoOf, measurementOf, normalizeCollateral, buildAttestation } from '../src/tee.js';
import { toUnits, toolHandlers, runTask, TOOLS } from '../src/agent.js';
import { keyPairFromPassphrase, recipientFingerprint, open } from '../src/privacy.js';

const DATA = new URL('../../contract/test-data/', import.meta.url);
const QUOTE = fs.readFileSync(new URL('tdx_quote.bin', DATA));
const COLLATERAL = JSON.parse(fs.readFileSync(new URL('tdx_quote_collateral.json', DATA), 'utf8'));

const ev = (event, payload) => {
  const p = Buffer.from(payload);
  const t = Buffer.alloc(4); t.writeUInt32LE(0x08000001);
  const digest = crypto.createHash('sha384').update(Buffer.concat([t, Buffer.from(':'), Buffer.from(event), Buffer.from(':'), p])).digest('hex');
  return { imr: 3, event_type: 0x08000001, digest, event, event_payload: p.toString('hex') };
};
const COMPOSE = '{"manifest_version":2,"name":"banbo-agent"}';
const COMPOSE_HASH = crypto.createHash('sha256').update(COMPOSE).digest('hex');
const TCB = {
  mrtd: '01'.repeat(48), rtmr0: '02'.repeat(48), rtmr1: '03'.repeat(48), rtmr2: '04'.repeat(48), rtmr3: '05'.repeat(48),
  app_compose: COMPOSE, compose_hash: COMPOSE_HASH,
  event_log: [ev('compose-hash', Buffer.from(COMPOSE_HASH, 'hex')), ev('key-provider', '{"name":"kms"}'), { imr: 0, event_type: 1, digest: 'aa', event: '', event_payload: '' }],
};

test('agent key is deterministic and its account is the implicit account of the key', () => {
  const a = agentKeyFromMaterial(Buffer.alloc(32, 9));
  const b = agentKeyFromMaterial(Buffer.alloc(32, 9));
  assert.equal(a.accountId, b.accountId);
  assert.match(a.accountId, /^[0-9a-f]{64}$/);
  assert.notEqual(a.accountId, agentKeyFromMaterial(Buffer.alloc(32, 8)).accountId);
  // ed25519:<base58 public key> decodes to the same 32 bytes as the account id.
  assert.equal(Buffer.from(a.keyPair.getPublicKey().data).toString('hex'), a.accountId);
});

test('report data is the account followed by zeros', () => {
  const rd = reportData('ab'.repeat(32));
  assert.equal(rd.length, 64);
  assert.equal(rd.toString('hex'), 'ab'.repeat(32) + '00'.repeat(32));
  assert.throws(() => reportData('alice.near'));
});

test('tcb info and measurement are read from either dstack format', () => {
  const asString = tcbInfoOf({ tcb_info: JSON.stringify({ ...TCB, compose_hash: undefined }) });
  assert.equal(asString.compose_hash, COMPOSE_HASH, 'falls back to hashing app_compose');
  const m = measurementOf(tcbInfoOf({ tcb_info: { ...TCB, mrtd: `0x${'01'.repeat(48).toUpperCase()}` } }));
  assert.deepEqual(Object.keys(m), ['mrtd', 'rtmr0', 'rtmr1', 'rtmr2', 'compose_hash', 'key_provider_digest']);
  assert.equal(m.mrtd, '01'.repeat(48));
  assert.equal(m.key_provider_digest, TCB.event_log[1].digest);
});

test('collateral is normalized to hex, as the contract expects', () => {
  const n = normalizeCollateral(COLLATERAL);
  assert.equal(n.root_ca_crl, COLLATERAL.root_ca_crl);
  const asArrays = normalizeCollateral({ ...COLLATERAL, pck_crl: [...Buffer.from(COLLATERAL.pck_crl, 'hex')] });
  assert.equal(asArrays.pck_crl, COLLATERAL.pck_crl);
});

test('the JS verifier accepts the genuine sample quote with this collateral (same data the contract verifies)', () => {
  const r = dcapVerify(QUOTE, normalizeCollateral(COLLATERAL), 1_751_328_000);
  assert.ok(r.status, 'verified report has a TCB status');
  assert.throws(() => dcapVerify(QUOTE, normalizeCollateral(COLLATERAL), 1_751_328_000 + 120 * 86_400));
});

test('buildAttestation binds the quote to the account and carries the event log', async () => {
  const acct = agentKeyFromMaterial(Buffer.alloc(32, 1)).accountId;
  let asked;
  const client = {
    getQuote: async (rd) => { asked = Buffer.from(rd).toString('hex'); return { quote: `0x${QUOTE.toString('hex')}`, event_log: JSON.stringify(TCB.event_log) }; },
    info: async () => ({ tcb_info: JSON.stringify(TCB) }),
  };
  const { attestation, measurement } = await buildAttestation(client, acct, async () => COLLATERAL);
  assert.equal(asked, acct + '00'.repeat(32));
  assert.equal(attestation.quote, QUOTE.toString('hex'));
  assert.equal(attestation.tcb_info.compose_hash, COMPOSE_HASH);
  assert.equal(attestation.tcb_info.event_log.length, 3);
  assert.equal(measurement.compose_hash, COMPOSE_HASH);
});

test('amounts convert exactly', () => {
  assert.equal(toUnits('2.5', 6), '2500000');
  assert.equal(toUnits('0.25', 24), '250000000000000000000000');
  assert.throws(() => toUnits('1.0000001', 6));
  assert.throws(() => toUnits('-1', 6));
  assert.throws(() => toUnits('1e3', 6));
});

test('the model never sees salts: tools have no salt field, the runtime adds it', async () => {
  assert.ok(!JSON.stringify(TOOLS).includes('salt'));
  const calls = [];
  const vault = {
    accountId: 'agent.near',
    view: async (m) => (m === 'list_tokens' ? [{ token: 'usdc.near', symbol: 'USDC', decimals: 6 }] : null),
    requestPayment: async (a) => { calls.push(a); return { outcome: { outcome: 'dispatched', key: 'k' }, tx: 't' }; },
  };
  const h = toolHandlers({ vault, vaultId: 'vault.near', salts: { 'quiet.near': 'ab'.repeat(32) } });
  const r = await h.request_payment({ recipient: 'quiet.near', amount: '1.5', asset: 'usdc', memo: 'data' });
  assert.equal(r.outcome, 'dispatched');
  assert.deepEqual(calls[0].salts, { 'quiet.near': 'ab'.repeat(32) });
  assert.equal(calls[0].amount, '1500000');
  assert.equal(calls[0].token, 'usdc.near');
  assert.deepEqual(await h.request_payment({ recipient: 'x.near', amount: '1', asset: 'DOGE', memo: '' }), { error: 'the vault does not hold DOGE' });
});

test('paid API flow: pays the quote through the vault, refuses quotes for another vault', async () => {
  const paid = [];
  const vault = { accountId: 'agent.near', view: async () => [], requestPayment: async (a) => { paid.push(a); return { outcome: { outcome: 'dispatched' }, tx: 't' }; } };
  const quote = { id: 'q-1', price: '250000', token: 'usdc.near', recipient: 'api.near', vault: 'vault.near', memo: 'USDC forecast' };
  const fetchImpl = async (_url, opts) => (opts?.headers?.['x-banbo-payment']
    ? { status: 200, json: async () => ({ data: { ok: 1 } }) }
    : { status: 402, json: async () => ({ quote }) });
  const h = toolHandlers({ vault, vaultId: 'vault.near', salts: {}, fetchImpl });
  assert.deepEqual(await h.call_paid_api({ url: 'https://api.example/v1/forecast' }), { status: 'ok', data: { ok: 1 }, tx: 't' });
  assert.equal(paid[0].requestId, 'q-1');
  const other = toolHandlers({ vault, vaultId: 'mine.near', salts: {}, fetchImpl });
  assert.equal((await other.call_paid_api({ url: 'https://api.example/v1/forecast' })).error, 'quote_for_another_vault');
});

test('agent loop runs tool calls and returns the summary', async () => {
  let n = 0;
  const chat = async () => (n++ === 0
    ? { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'request_payment', arguments: '{"recipient":"api.near","amount":"0.1","asset":"NEAR","memo":"x"}' } }] }
    : { role: 'assistant', content: 'Paid api.near 0.1 NEAR.' });
  const events = [];
  const r = await runTask('pay', { handlers: { request_payment: async () => ({ outcome: 'dispatched' }) }, chat, onEvent: (e) => events.push(e) });
  assert.equal(r.summary, 'Paid api.near 0.1 NEAR.');
  assert.equal(events[0].result.outcome, 'dispatched');
});

test('privacy helpers match the shared vectors', () => {
  const k = keyPairFromPassphrase('banbo sandbox demo', 'vault.test.near');
  assert.equal(k.publicKey, 'x25519:78540f435d8cae6c85681c7c02871ee89045b8833b8feb2186393cebd683fd3b');
  assert.equal(recipientFingerprint('quiet-vendor.near', '5ab1e5a1'.repeat(8)), 'f9ae7fcae4957690fa095cf6a61488e15fb351d612b6a3e343a8f946fd2af7b8');
  assert.equal(open('enc1:kkTiXa5nriEbY3lBIOk9hs3auQToJ1OrBTTlRmU4FSDyEbgOkl2WfcXfKRTloFVom1rPjJSH1Jm6RmPRz+9oi7+lES+5AwnURTtQvwCLVh1okZYBWjOzYZ/ZDvqTbqRasDiCiTyX3Q==', k.secretKey), 'Private dataset, November batch');
});
