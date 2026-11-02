import { describe, expect, it } from 'vitest';
import { near, toYocto, toUnits, units, pct, ago, duration, until, originText, reasonText } from './format';

describe('amounts', () => {
  it('round-trips NEAR and yoctoNEAR exactly', () => {
    expect(toYocto('1')).toBe('1000000000000000000000000');
    expect(toYocto('0.5')).toBe('500000000000000000000000');
    expect(toYocto('0.000000000000000000000001')).toBe('1');
    expect(near(toYocto('12345.678'))).toBe('12,345.678');
  });
  it('rounds display down, never up', () => {
    expect(near('999999999999999999999999')).toBe('0.999');
    expect(near('0')).toBe('0');
  });
  it('rejects malformed input', () => {
    for (const bad of ['', '-1', '1e3', '1.', '.5', 'abc', '0.' + '1'.repeat(25)]) expect(() => toYocto(bad)).toThrow();
  });
  it('caps percentages and handles a zero limit', () => {
    expect(pct('5', '10')).toBe(50);
    expect(pct('20', '10')).toBe(100);
    expect(pct('1', '0')).toBe(0);
  });
  it('formats relative time', () => {
    expect(ago(1000, 3000)).toBe('just now');
    expect(ago(0, 3 * 60_000)).toBe('3m ago');
  });
});

describe('token amounts', () => {
  it('shows USDC with cents and parses 6 decimals', () => {
    expect(units('7500000', 6)).toBe('7.50');
    expect(units('490100000', 6)).toBe('490.10');
    expect(units('1', 6)).toBe('0.00');
    expect(toUnits('12.345678', 6)).toBe('12345678');
    expect(() => toUnits('1.0000001', 6)).toThrow();
  });
});

describe('risk rule durations', () => {
  it('formats cooldowns and time left', () => {
    expect(duration(0)).toBe('Off');
    expect(duration(3_600_000)).toBe('1 hour');
    expect(duration(90 * 60_000)).toBe('1.5 hours');
    expect(duration(10 * 60_000)).toBe('10 minutes');
    expect(until(3_600_000, 0)).toBe('in 1h');
    expect(until(42 * 60_000, 0)).toBe('in 42m');
  });
});

describe('originText', () => {
  it('describes each kind of origin in words', () => {
    expect(originText({ kind: 'owner' })).toBe('you (the owner)');
    expect(originText({ kind: 'source', source: 'email:acme.com' })).toBe('an email from acme.com (DKIM verified)');
    expect(originText({ kind: 'source', source: 'email:unverified' })).toBe('an email that failed DKIM');
    expect(originText({ kind: 'source', source: 'web:portal.acme.com' })).toBe('the web page at portal.acme.com');
    expect(originText({ kind: 'source', source: 'doc:inv.pdf' })).toBe('the file inv.pdf');
    expect(originText(null)).toBe('not labelled');
  });
  it('explains the new refusal reasons', () => {
    expect(reasonText('recipient_from_untrusted_source')).toMatch(/document/);
    expect(reasonText('amount_from_untrusted_source')).toMatch(/source/);
  });
});
