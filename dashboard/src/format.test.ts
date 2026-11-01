import { describe, expect, it } from 'vitest';
import { near, toYocto, pct, ago } from './format';

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
