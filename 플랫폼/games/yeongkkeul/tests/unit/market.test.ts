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

  it('quotes a quiet stock every few seconds and a busy one every tick', () => {
    const m = new Market(seededRng(5));
    const changes: Record<string, number> = {};
    let last = m.prices();
    for (let i = 0; i < 60 * SEC; i++) {
      m.step();
      const now = m.prices();
      for (const id of Object.keys(now)) if (now[id] !== last[id]) changes[id] = (changes[id] ?? 0) + 1;
      last = now;
    }
    for (const s of m.stocks) {
      const expected = 60 / Math.max(s.def.volume.quoteSec, T.tickMs / 1000);
      expect(changes[s.def.id], s.def.id).toBeGreaterThan(expected * 0.6);
      expect(changes[s.def.id], s.def.id).toBeLessThan(expected * 1.4 + 3);
    }
    expect(changes.kingka).toBeLessThan(changes.gamestop / 5);
  });

  it('keeps each tendency over 5 minutes, pays neither direction, and the next seconds stay a coin flip', () => {
    const rng = seededRng(4);
    const N = 300;
    const GAME = 300 * SEC;
    const ups: Record<string, number> = {};
    const ends: Record<string, number[]> = {};
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
        (ends[id] ??= []).push(s.price / s.def.start);
        const p = (persist[id] ??= [0, 0]);
        for (let j = 1; j < moves[k].length; j++) {
          p[0] += moves[k][j] === moves[k][j - 1] ? 1 : 0;
          p[1]++;
        }
      });
    }
    expect(ups.kingka).toBeGreaterThan(0.52); // mostly climbs (and sometimes drops hard)
    expect(ups.lownix).toBeGreaterThan(0.55);
    expect(ups.mwodna).toBeLessThan(0.4); // mostly slides (and sometimes spikes)
    for (const [id, xs] of Object.entries(ends)) {
      // 인버스 exists and the market never closes, so the expected price must not move either way.
      const mean = xs.reduce((s, x) => s + x, 0) / N;
      const sd = Math.sqrt(xs.reduce((s, x) => s + (x - mean) ** 2, 0) / N);
      expect(Math.abs(mean - 1), id).toBeLessThan((3 * sd) / Math.sqrt(N));
    }
    for (const id of ['kingka', 'lownix', 'dolge', 'mwodna']) {
      const [same, all] = persist[id];
      expect(same / all, id).toBeLessThan(0.58); // the last 10 s say little about the next 10 s
    }
  });
});
