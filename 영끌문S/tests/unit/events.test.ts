import { describe, expect, it } from 'vitest';
import type { EventDef, PatternDef } from '../../src/config.ts';
import { makeEvents } from '../../src/game/events.ts';
import { makePatterns } from '../../src/game/patterns.ts';
import { seededRng } from '../../src/rng.ts';

const DT = 0.1;
const WINDOW = 120;

/** An event that is one 1-tick jump of +0.1, nothing before or after it. */
const JUMP: EventDef = {
  chance: 1,
  up: 1,
  gain: [0.1, 0.1],
  drop: [0, 0],
  sec: [0.1, 0.1],
  lead: [0, 0],
  leadSec: [0, 0],
  giveBack: [0, 0],
  giveBackSec: [0, 0],
};

describe('events', () => {
  it('fire at most once per 2-minute window, at any moment of it, so two can come back to back', () => {
    let backToBack = 0;
    for (let seed = 1; seed <= 200; seed++) {
      const next = makeEvents(JUMP, seededRng(seed), DT, WINDOW);
      const fires: number[] = [];
      for (let t = 0; t < 5 * WINDOW * 10; t++) if (next() !== 0) fires.push(t * DT);
      const perWindow = new Map<number, number>();
      for (const at of fires) perWindow.set(Math.floor(at / WINDOW), (perWindow.get(Math.floor(at / WINDOW)) ?? 0) + 1);
      expect([...perWindow.values()].every((n) => n === 1)).toBe(true);
      expect(perWindow.size).toBe(5); // chance 1: every window has its event
      for (let i = 1; i < fires.length; i++) if (fires[i] - fires[i - 1] < 20) backToBack++;
    }
    expect(backToBack).toBeGreaterThan(0); // e.g. 1:50 and then 2:05
  });

  it('never fire with chance 0', () => {
    const next = makeEvents({ ...JUMP, chance: 0 }, seededRng(1), DT, WINDOW);
    for (let t = 0; t < 3 * WINDOW * 10; t++) expect(next()).toBe(0);
  });

  it('add up to the drawn move, then give back the drawn share', () => {
    const next = makeEvents({ ...JUMP, sec: [1, 2], giveBack: [0.5, 0.5], giveBackSec: [5, 5] }, seededRng(3), DT, WINDOW);
    let total = 0;
    for (let t = 0; t < WINDOW * 10; t++) total += next();
    expect(total).toBeCloseTo(0.05, 1); // +0.1, then half of it back
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
