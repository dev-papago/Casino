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

  it('keeps each tendency over a game while the next seconds stay a coin flip (many games)', () => {
    const rng = seededRng(4);
    const N = 200;
    const GAME = T.sessionSec * SEC;
    const ups: Record<string, number> = {};
    const mean: Record<string, number> = {};
    const persist: Record<string, [number, number]> = {};
    for (let g = 0; g < N; g++) {
      const m = new Market(rng);
      const last = m.stocks.map((s) => s.price);
      const moves: number[][] = m.stocks.map(() => []);
      for (let i = 1; i <= GAME; i++) {
        m.step();
        if (i % (10 * SEC)) continue;
        m.stocks.forEach((s, k) => {
          moves[k].push(Math.sign(s.price - last[k]));
          last[k] = s.price;
        });
      }
      m.stocks.forEach((s, k) => {
        const id = s.def.id;
        ups[id] = (ups[id] ?? 0) + (s.price > s.def.start ? 1 / N : 0);
        mean[id] = (mean[id] ?? 0) + (s.price / s.def.start - 1) / N;
        const p = (persist[id] ??= [0, 0]);
        for (let j = 1; j < moves[k].length; j++) {
          p[0] += moves[k][j] === moves[k][j - 1] ? 1 : 0;
          p[1]++;
        }
      });
    }
    expect(ups.kingka).toBeGreaterThan(0.65); // safe climb
    expect(mean.lownix).toBeGreaterThan(mean.kingka); // climbs faster on average
    expect(ups.lownix).toBeGreaterThan(0.55);
    expect(ups.mwodna).toBeLessThan(0.35); // declines
    for (const id of ['kingka', 'lownix', 'dolge', 'mwodna']) {
      const [same, all] = persist[id];
      expect(same / all, id).toBeLessThan(0.58); // the last 10 s say little about the next 10 s
    }
  });
});
