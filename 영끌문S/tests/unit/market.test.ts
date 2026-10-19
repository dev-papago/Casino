import { describe, expect, it } from 'vitest';
import { CONFIG } from '../../src/config.ts';
import { Market } from '../../src/game/market.ts';
import { seededRng } from '../../src/rng.ts';

const T = CONFIG.timing;
const SEC = 1000 / T.tickMs;

describe('market', () => {
  it('opens at each start price with the configured history', () => {
    const m = new Market(seededRng(1));
    for (const s of m.stocks) {
      expect(s.candles).toHaveLength(T.historyCandles);
      if (s.candles.length) expect(s.candles[s.candles.length - 1].c).toBeCloseTo(s.def.start, 6);
      expect(s.price).toBe(s.def.start);
      expect(s.live).toEqual({ o: s.def.start, h: s.def.start, l: s.def.start, c: s.def.start });
    }
  });

  it('closes one candle per ticksPerCandle ticks, with consistent high and low', () => {
    const m = new Market(seededRng(2));
    for (let i = 0; i < T.ticksPerCandle * 30; i++) m.step();
    for (const s of m.stocks) {
      expect(s.candles).toHaveLength(T.historyCandles + 30);
      for (const c of s.candles) {
        expect(c.h).toBeGreaterThanOrEqual(Math.max(c.o, c.c));
        expect(c.l).toBeLessThanOrEqual(Math.min(c.o, c.c));
      }
    }
  });

  it('is deterministic for a seed and keeps prices finite and positive for a long game', () => {
    const a = new Market(seededRng(3));
    const b = new Market(seededRng(3));
    for (let i = 0; i < 30 * 60 * SEC; i++) {
      a.step();
      b.step();
    }
    expect(a.prices()).toEqual(b.prices());
    for (const s of a.stocks) {
      expect(Number.isFinite(s.price)).toBe(true);
      expect(s.price).toBeGreaterThan(0);
      expect(s.candles.length).toBeLessThanOrEqual(T.keepCandles + 100);
    }
  });

  it('follows the designed tendencies over 3 minutes (average of many games)', () => {
    const rng = seededRng(4);
    const sums: Record<string, number> = {};
    const N = 200;
    for (let g = 0; g < N; g++) {
      const m = new Market(rng);
      for (let i = 0; i < 180 * SEC; i++) m.step();
      for (const s of m.stocks) sums[s.def.id] = (sums[s.def.id] ?? 0) + Math.log(s.price / s.def.start) / N;
    }
    expect(sums.kingka).toBeGreaterThan(0); // safe climb
    expect(sums.lownix).toBeGreaterThan(sums.kingka); // climbs faster
    expect(sums.mwodna).toBeLessThan(0); // declines
  });
});
