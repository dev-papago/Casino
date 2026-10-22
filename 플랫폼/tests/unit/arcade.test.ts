// The arcade games' tables: exact return (96%), integer payouts and the round rules.
import { describe, expect, it } from 'vitest';
import { weighted } from '../../games/arcade/rng.ts';
import { BOARDS, BOARD_IDS, pathTo } from '../../games/plinko/src/table.ts';
import { LOSING, MIX, REEL_MIX, STRIPS, SYMBOLS, WINNING, evaluate as slotEval, lineAt, slotRtp, spin } from '../../games/slot/src/table.ts';
import { TILT_TRIES, tiltedDraw } from '../../games/arcade/rng.ts';
import { drawSlotTilted } from '../../games/plinko/src/table.ts';
import { keepChance, type Tilt } from '../../sdk/casino.ts';
import yabawiConfig from '../../games/yabawi/src/config/defaults.json';
import { tiltedShuffle } from '../../games/yabawi/src/game/tilt.ts';
import { autoFinish, canRoll, evaluate, firstRoll, roll, type RoundState } from '../../games/yacht/src/rules.ts';

/** A counter "RNG" that walks through every value: deterministic and covers the range. */
const seq = (values: number[]) => {
  let i = 0;
  return (n: number) => values[i++ % values.length] % n;
};

describe('plinko', () => {
  it.each(BOARD_IDS)('%s returns exactly 86% with integer multipliers', (id) => {
    const b = BOARDS[id];
    expect(b.mults).toHaveLength(b.rows + 1);
    expect(b.weights).toHaveLength(b.rows + 1);
    expect(b.weights.reduce((a, w) => a + w, 0)).toBe(1_000_000);
    expect(b.mults.every(Number.isInteger)).toBe(true);
    expect(b.weights.reduce((a, w, i) => a + w * b.mults[i], 0)).toBe(860_000);
  });

  it('a path ends in its slot', () => {
    const b = BOARDS.hard;
    for (let slot = 0; slot <= b.rows; slot++) {
      const p = pathTo(b, slot, seq([3, 1, 4, 1, 5, 9, 2, 6]));
      expect(p).toHaveLength(b.rows);
      expect(p.filter(Boolean).length).toBe(slot);
    }
  });

  it('weighted() follows the weights', () => {
    // r walks 0..9: weights [2, 3, 5] → 2 zeros, 3 ones, 5 twos
    const out = Array.from({ length: 10 }, (_, r) => weighted([2, 3, 5], () => r));
    expect(out).toEqual([0, 0, 1, 1, 1, 2, 2, 2, 2, 2]);
  });

});

describe('slot', () => {
  it('strips follow the reel mix', () => {
    STRIPS.forEach((strip, r) => {
      expect(strip).toHaveLength(20);
      for (const s of SYMBOLS) expect(strip.filter((x) => x === s).length).toBe(REEL_MIX[r][s]);
    });
  });

  it('returns exactly 88%: fair stops pay 7,800 / 8,000, and 7,040 of 7,800 spins are fair', () => {
    let total = 0;
    for (const a of STRIPS[0]) for (const b of STRIPS[1]) for (const c of STRIPS[2]) total += slotEval([a, b, c]).mult;
    expect(total).toBe(7800);
    expect(LOSING.every((stops) => slotEval(lineAt(stops)).mult === 0)).toBe(true);
    expect(LOSING).toHaveLength(4162);
    expect(WINNING).toHaveLength(8000 - 4162);
    expect(MIX).toEqual({ fair: 7040, win: 0, of: 7800 });
    expect(slotRtp()).toBeCloseTo(0.88, 12);
    expect(spin(seq([7040, 5]))).toEqual(LOSING[5]); // the first draw past the fair ones: a losing line
    expect(spin(seq([7039, 1, 2, 3]))).toEqual([1, 2, 3]); // a fair spin
  });

  it('pays the right line', () => {
    expect(slotEval(['7', '7', '7']).mult).toBe(50);
    expect(slotEval(['🍒', '7', '7']).mult).toBe(7);
    expect(slotEval(['🍋', '🍀', '🍋']).mult).toBe(1);
    expect(slotEval(['🍋', '🍀', '🍒']).mult).toBe(0);
  });
});

describe('yacht', () => {
  it('hands', () => {
    expect(evaluate([6, 6, 6, 6, 6]).mult).toBe(20);
    expect(evaluate([3, 1, 2, 5, 4]).mult).toBe(2);
    expect(evaluate([6, 2, 3, 4, 5]).mult).toBe(2);
    expect(evaluate([6, 6, 6, 6, 5]).mult).toBe(6); // 29
    expect(evaluate([1, 1, 1, 1, 2]).mult).toBe(6); // 6
    expect(evaluate([6, 6, 6, 5, 5]).mult).toBe(2); // 28
    expect(evaluate([6, 6, 5, 5, 5]).mult).toBe(1); // 27
    expect(evaluate([1, 1, 2, 2, 2]).mult).toBe(1); // 8
    expect(evaluate([3, 3, 4, 4, 6]).mult).toBe(0); // 20: the old 12–23 push band is gone
  });

  it('held dice lock, and one die must always roll', () => {
    let s: RoundState = firstRoll(seq([0, 1, 2, 3, 4]));
    expect(s.dice).toEqual([1, 2, 3, 4, 5]);
    s = { ...s, held: [true, true, false, false, false] };
    s = roll(s, seq([5]));
    expect(s.dice).toEqual([1, 2, 6, 6, 6]);
    expect(s.locked).toEqual([true, true, false, false, false]);
    s = { ...s, held: [false, false, true, true, true] }; // releasing a locked die is not possible
    expect(canRoll(s)).toBe(false); // all five kept
    s = { ...s, held: [false, false, true, true, false] };
    expect(canRoll(s)).toBe(true);
    s = roll(s, seq([0]));
    expect(s.dice).toEqual([1, 2, 6, 6, 1]);
    expect(s.rolls).toBe(3);
    expect(canRoll(s)).toBe(false);
  });

  it('a round left in the middle keeps the chosen dice and rolls out the rest', () => {
    const s: RoundState = { dice: [6, 6, 6, 2, 3], held: [true, true, true, false, false], locked: [false, false, false, false, false], rolls: 1 };
    const end = autoFinish(s, seq([5]));
    expect(end).toEqual([6, 6, 6, 6, 6]);
    const all: RoundState = { ...s, held: [true, true, true, true, true], locked: [true, false, false, false, false], rolls: 2 };
    expect(autoFinish(all, seq([0]))).toEqual([6, 1, 1, 1, 1]); // all chosen: only the locked die stays
  });
});

describe('승리 추세', () => {
  const t: Tilt = { center: 8, left: 8, right: 2, bust: 16 };

  it('keeps every result toward the center, and fewer the further one leads away', () => {
    expect(keepChance(4, 8, t)).toBe(1);
    expect(keepChance(20, 10, t)).toBe(1);
    expect(keepChance(8, 8, t)).toBe(1);
    expect(keepChance(8, 16, t)).toBeLessThan(1);
    expect(keepChance(8, 32, t)).toBeLessThan(keepChance(8, 16, t));
    expect(keepChance(8, 4, t)).toBeLessThan(keepChance(8, 16, t)); // the left side is steeper
    expect(keepChance(8, 0, t)).toBeCloseTo(keepChance(8, 0.5, t)); // broke: like keeping 1/16
  });

  it('draws again until a result is kept, at most TILT_TRIES times', () => {
    let n = 0;
    expect(tiltedDraw(() => ++n, (x) => (x === 3 ? 1 : 0))).toBe(3);
    n = 0;
    expect(tiltedDraw(() => ++n, () => 0)).toBe(TILT_TRIES);
    const b = BOARDS.easy;
    const middle = b.weights.slice(0, 5).reduce((a, w) => a + w, 0); // weighted() on this lands in the 0x middle
    expect(drawSlotTilted(b, () => 1, seq([middle]))).toBe(5);
    expect(drawSlotTilted(b, (m) => (m > 0 ? 1 : 0), seq([middle, 0, 0]))).toBe(0);
  });

  it('eases 야바위 under the center and tightens it over, by the balance only', () => {
    const coin = (u: number) => () => u;
    expect(tiltedShuffle('normal', 2, yabawiConfig, coin(0))).toBe('easy');
    expect(tiltedShuffle('normal', 40, yabawiConfig, coin(0))).toBe('hardest');
    expect(tiltedShuffle('normal', yabawiConfig.tilt.center, yabawiConfig, coin(0))).toBe('normal');
    expect(tiltedShuffle('hardest', 40, yabawiConfig, coin(0))).toBe('hardest'); // nothing harder than 최상
  });
});
