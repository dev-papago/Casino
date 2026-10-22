import { describe, expect, it } from 'vitest';
import type { EventDef, PatternDef } from '../../src/config.ts';
import { makeEvents } from '../../src/game/events.ts';
import { makePatterns } from '../../src/game/patterns.ts';
import { seededRng } from '../../src/rng.ts';

const DT = 0.1;
const WINDOW = 120;
const TICKS = WINDOW / DT;

/** An event that is one 1-tick jump of +0.1, in 9 windows out of 10. */
const JUMP: EventDef = { chance: 0.9, up: 1, gain: [0.1, 0.1], drop: [0, 0], sec: [0.1, 0.1] };

describe('events', () => {
  it('fire at most once per 2-minute window, at any moment of it, so two can come back to back', () => {
    let backToBack = 0;
    let windows = 0;
    for (let seed = 1; seed <= 200; seed++) {
      const next = makeEvents(JUMP, seededRng(seed), DT, WINDOW);
      const fires: number[] = [];
      for (let t = 0; t < 5 * TICKS; t++) if (next() > 0.05) fires.push(t * DT);
      const perWindow = new Map<number, number>();
      for (const at of fires) perWindow.set(Math.floor(at / WINDOW), (perWindow.get(Math.floor(at / WINDOW)) ?? 0) + 1);
      expect([...perWindow.values()].every((n) => n === 1)).toBe(true);
      windows += perWindow.size;
      for (let i = 1; i < fires.length; i++) if (fires[i] - fires[i - 1] < 20) backToBack++;
    }
    expect(windows / 1000).toBeCloseTo(0.9, 1);
    expect(backToBack).toBeGreaterThan(0); // e.g. 1:50 and then 2:05
  });

  it('never fire with chance 0', () => {
    const next = makeEvents({ ...JUMP, chance: 0 }, seededRng(1), DT, WINDOW);
    for (let t = 0; t < 3 * TICKS; t++) expect(next()).toBe(0);
  });

  it('are paid for: the expected price stays put, and nothing moves once the window has had its event', () => {
    const def: EventDef = { chance: 0.6, up: 0.3, gain: [0.2, 0.45], drop: [0.1, 0.3], sec: [0.1, 0.4] };
    const ends: number[] = [];
    for (let seed = 1; seed <= 4000; seed++) {
      const next = makeEvents(def, seededRng(seed), DT, WINDOW);
      let x = 0;
      let quietAfter = true;
      let fired = -1;
      for (let t = 0; t < TICKS; t++) {
        const d = next();
        if (fired < 0 && Math.abs(d) > 0.01) fired = t;
        else if (fired >= 0 && t > fired + 4 && d !== 0) quietAfter = false;
        x += d;
      }
      expect(quietAfter).toBe(true); // no drift left to time after the event
      ends.push(Math.exp(x));
    }
    const mean = ends.reduce((s, v) => s + v, 0) / ends.length;
    const sd = Math.sqrt(ends.reduce((s, v) => s + (v - mean) ** 2, 0) / ends.length);
    expect(Math.abs(mean - 1)).toBeLessThan((3 * sd) / Math.sqrt(ends.length));
  });
});

describe('chart formations', () => {
  const def: PatternDef = { amp: 0.05, sec: [40, 90], gapSec: [5, 20], bubble: 0.1, bubbleSec: [120, 200], bubbleAmp: 0.3 };

  it('move the price nowhere on average: mirrored at random, random breakouts', () => {
    const ends: number[] = [];
    for (let seed = 1; seed <= 400; seed++) {
      const next = makePatterns(def, seededRng(seed), DT);
      let x = 0;
      for (let t = 0; t < 600 * 10; t++) x += next();
      ends.push(x);
    }
    const mean = ends.reduce((s, x) => s + x, 0) / ends.length;
    const sd = Math.sqrt(ends.reduce((s, x) => s + (x - mean) ** 2, 0) / ends.length);
    expect(sd).toBeGreaterThan(0.02); // they do move the price
    expect(Math.abs(mean)).toBeLessThan((3 * sd) / Math.sqrt(ends.length)); // but not one way
  });

  it('do nothing when switched off', () => {
    const next = makePatterns({ ...def, amp: 0, bubble: 0 }, seededRng(1), DT);
    for (let t = 0; t < 600 * 10; t++) expect(next()).toBe(0);
  });
});
