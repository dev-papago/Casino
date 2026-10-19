import { describe, expect, it } from 'vitest';
import { cryptoRng, rngFromSource, seededRng } from '../../src/rng';

describe('rng', () => {
  it('int(n) is always an integer in [0, n)', () => {
    const bad: string[] = [];
    for (const rng of [seededRng(1), cryptoRng()]) {
      for (const n of [1, 2, 3, 7]) {
        const seen = new Set<number>();
        for (let i = 0; i < 20_000; i++) {
          const v = rng.int(n);
          if (!Number.isInteger(v) || v < 0 || v >= n) bad.push(`int(${n}) = ${v}`);
          seen.add(v);
        }
        expect(seen.size).toBe(n);
      }
    }
    expect(bad).toEqual([]);
  });

  it('int(3) is uniform: chi-square < 9.21 over 60,000 draws', () => {
    const rng = seededRng(20261019);
    const counts = [0, 0, 0];
    const N = 60_000;
    for (let i = 0; i < N; i++) counts[rng.int(3)]++;
    const chi2 = counts.reduce((s, c) => s + (c - N / 3) ** 2 / (N / 3), 0);
    expect(chi2).toBeLessThan(9.21);
  });

  it('rejects 0xFFFFFFFF for n = 3 and draws again', () => {
    const values = [0xffffffff, 0xffffffff, 7];
    let calls = 0;
    const rng = rngFromSource(() => values[calls++]);
    expect(rng.int(3)).toBe(7 % 3);
    expect(calls).toBe(3);
  });

  it('accepts the largest value below the limit', () => {
    let calls = 0;
    const rng = rngFromSource(() => (calls++, 0xfffffffe));
    expect(rng.int(3)).toBe(0xfffffffe % 3);
    expect(calls).toBe(1);
  });

  it('float is in [0, 1) and coin gives both sides', () => {
    const rng = seededRng(5);
    const sides = new Set<boolean>();
    for (let i = 0; i < 1000; i++) {
      const f = rng.float();
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThan(1);
      sides.add(rng.coin());
    }
    expect(sides.size).toBe(2);
    expect(rngFromSource(() => 0xffffffff).float()).toBeLessThan(1);
  });

  it('seededRng is reproducible', () => {
    const a = seededRng(42), b = seededRng(42);
    for (let i = 0; i < 100; i++) expect(a.int(1000)).toBe(b.int(1000));
  });

  it('rejects bad n', () => {
    const rng = seededRng(1);
    for (const n of [0, -1, 1.5, NaN]) expect(() => rng.int(n)).toThrow(RangeError);
  });
});
