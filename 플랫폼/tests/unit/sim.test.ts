// The 확률 시뮬레이터 plays the real game code: over many 1-chip rounds each game returns what it was tuned for, and
// with the 승리 추세 bold guests end in a skewed bell.
import { describe, expect, it } from 'vitest';
import { DEFAULTS, PACE, TOP, fastRng, simulate, type SimParams } from '../../src/sim/engine.ts';

/** One guest with a huge balance playing `rounds` 1-chip rounds: returned / wagered is the game's own RTP. */
function rtp(game: SimParams['game'], rounds: number, extra: Partial<SimParams> = {}): number {
  const r = simulate(
    { ...DEFAULTS, game, start: 10_000_000, bet: { kind: 'fixed', chips: 1 }, minutes: 1, perMin: rounds, goal: 0, guests: 1, luck: false, ...extra },
    fastRng(7),
  );
  expect(r.rounds).toBe(rounds);
  return r.returned / r.wagered;
}

describe('simulator', () => {
  it('plays each game at its tuned return', () => {
    expect(rtp('plinko', 300_000)).toBeCloseTo(0.86, 1);
    expect(Math.abs(rtp('plinko', 300_000) - 0.86)).toBeLessThan(0.02);
    expect(Math.abs(rtp('slot', 300_000) - 0.88)).toBeLessThan(0.015);
    expect(Math.abs(rtp('yacht', 100_000) - 0.93)).toBeLessThan(0.025); // the average player of rules.ts
    expect(Math.abs(rtp('yabawi', 300_000) - 0.91)).toBeLessThan(0.01);
  });

  it('counts every guest once, between 0 and 50', () => {
    const r = simulate({ ...DEFAULTS, game: 'slot', guests: 3000, luck: false }, fastRng(1));
    expect(r.counts).toHaveLength(TOP + 1);
    expect(r.counts.reduce((a, x) => a + x, 0)).toBe(3000);
    // Without the 승리 추세, bold bets end at 0 or at 50 for most guests.
    expect(r.counts[0] + r.counts[TOP]).toBeGreaterThan(r.counts.slice(1, TOP).reduce((a, x) => a + x, 0));
  });

  it('with the 승리 추세, bold guests end in a skewed bell: few broke, most in 5–19, a thin tail to 50', () => {
    for (const game of ['plinko', 'slot', 'yacht'] as const) {
      const r = simulate({ ...DEFAULTS, game, perMin: PACE[game], guests: 3000 }, fastRng(2));
      const share = (a: number, b: number) => r.counts.slice(a, b + 1).reduce((s, x) => s + x, 0) / r.guests;
      expect(share(0, 0), game).toBeLessThan(0.13);
      expect(share(5, 19), game).toBeGreaterThan(0.6);
      expect(share(TOP, TOP), game).toBeGreaterThan(0.01);
      expect(share(TOP, TOP), game).toBeLessThan(0.07);
      expect(r.mean, game).toBeGreaterThan(8);
      expect(r.mean, game).toBeLessThan(14);
    }
  }, 30_000);

  it('runs 영끌문S sessions on the real market', () => {
    const r = simulate({ ...DEFAULTS, game: 'yeongkkeul', guests: 4, minutes: 3 }, fastRng(3));
    expect(r.counts.reduce((a, x) => a + x, 0)).toBe(4);
    expect(r.rounds).toBeGreaterThan(0);
  });
});
