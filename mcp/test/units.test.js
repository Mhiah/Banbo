import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseUnits, formatUnits, amountsIn } from '../src/units.js';
import { checkAccessKey } from '../src/vault.js';

test('parseUnits is exact and strict', () => {
  assert.equal(parseUnits('0.3', 24), '300000000000000000000000');
  assert.equal(parseUnits('0.30', 24), parseUnits('0.3', 24));
  assert.equal(parseUnits('7.50', 6), '7500000');
  assert.equal(parseUnits('12', 6), '12000000');
  for (const bad of ['', '-1', '1e3', '0x10', '1.2.3', '1,000', ' . ', 'NaN']) assert.throws(() => parseUnits(bad, 6), bad);
  assert.throws(() => parseUnits('0.1234567', 6), /decimal places/);
});

test('formatUnits trims trailing zeros', () => {
  assert.equal(formatUnits('300000000000000000000000', 24), '0.3');
  assert.equal(formatUnits('7500000', 6), '7.5');
  assert.equal(formatUnits('12000000', 6), '12');
  assert.equal(formatUnits('0', 6), '0');
});

test('amountsIn finds every written number, with thousands separators', () => {
  const found = amountsIn('Invoice 1042\nAmount due: 1,250.00 USDC (was 0.30)', 6);
  assert.ok(found.has(parseUnits('1250', 6)));
  assert.ok(found.has(parseUnits('0.3', 6)));
  assert.ok(found.has(parseUnits('1042', 6)));
  assert.ok(!found.has(parseUnits('0.45', 6)));
});

test('checkAccessKey refuses full-access keys and keys for another contract', () => {
  assert.throws(() => checkAccessKey('FullAccess', 'vault.near'), /full-access/);
  assert.match(checkAccessKey('FullAccess', 'vault.near', { allowFullAccess: true }), /testing only/);
  const fc = (receiver_id, method_names) => ({ FunctionCall: { receiver_id, method_names, allowance: null } });
  assert.match(checkAccessKey(fc('vault.near', ['request_payment']), 'vault.near'), /request_payment/);
  assert.throws(() => checkAccessKey(fc('other.near', ['request_payment']), 'vault.near'), /not the vault/);
  assert.throws(() => checkAccessKey(fc('vault.near', ['attest_agent']), 'vault.near'), /cannot call request_payment/);
});
