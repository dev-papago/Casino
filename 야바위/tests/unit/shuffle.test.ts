import { describe, expect, it } from 'vitest';
import { CONFIG, LEVEL_IDS, type LevelId } from '../../src/config';
import {
  SLOT_X,
  Y_RANGE,
  applyMove,
  belief,
  cupPoses,
  cupsAfter,
  generatePlan,
  moveTimes,
  type CupId,
  type Move,
  type Plan,
  type Pose,
  type Slot,
} from '../../src/game/shuffle';
import { seededRng } from '../../src/rng';

const T = CONFIG.timing;
const plans = (level: LevelId, n: number, seed: number): Plan[] => {
  const rng = seededRng(seed);
  return Array.from({ length: n }, () => generatePlan(level, CONFIG, rng));
};
const unordered = (ps: Pose[]) =>
  ps.map((p) => [p.x, p.y, p.z]).sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
const withCoins = (plan: Plan, coin: (i: number) => boolean): Plan => ({
  ...plan,
  moves: plan.moves.map((m, i) => (m.kind === 'overlap' ? { ...m, pass: coin(i) } : m)),
});
const argmax = (p: number[]) => p.indexOf(Math.max(...p));

describe('applyMove and belief', () => {
  const id: CupId[] = [0, 1, 2];
  it('permutes cups per the Move type', () => {
    expect(applyMove(id, { kind: 'swap', a: 0, b: 2, durMs: 1 })).toEqual([2, 1, 0]);
    expect(applyMove(id, { kind: 'rotate', dir: 1, durMs: 1 })).toEqual([2, 0, 1]);
    expect(applyMove(id, { kind: 'rotate', dir: 2, durMs: 1 })).toEqual([1, 2, 0]);
    expect(applyMove(id, { kind: 'overlap', a: 1, b: 2, pass: true, durMs: 1 })).toEqual([0, 2, 1]);
    expect(applyMove(id, { kind: 'overlap', a: 1, b: 2, pass: false, durMs: 1 })).toEqual([0, 1, 2]);
    expect(id).toEqual([0, 1, 2]); // input untouched
  });

  it('belief permutes on swap/rotate and averages on overlap', () => {
    const moves: Move[] = [
      { kind: 'rotate', dir: 1, durMs: 1 },
      { kind: 'overlap', a: 1, b: 2, pass: false, durMs: 1 },
      { kind: 'swap', a: 0, b: 1, durMs: 1 },
    ];
    expect(belief(0, moves)).toEqual([0.5, 0, 0.5]);
  });
});

describe('generatePlan', () => {
  it.each(LEVEL_IDS)('%s: counts, durations, totals and mix follow the config', (level) => {
    const sh = CONFIG.levels[level].shuffle;
    const kinds = new Set<string>();
    for (const p of plans(level, 2000, 11)) {
      expect(p.level).toBe(level);
      expect(p.moves.length).toBeGreaterThanOrEqual(sh.moves[0]);
      expect(p.moves.length).toBeLessThanOrEqual(sh.moves[1]);
      for (const m of p.moves) {
        kinds.add(m.kind);
        const mult = m.kind === 'overlap' ? T.overlapMsMult : 1;
        expect(m.durMs).toBeGreaterThanOrEqual(Math.round(sh.moveMs[0] * mult));
        expect(m.durMs).toBeLessThanOrEqual(Math.round(sh.moveMs[1] * mult));
      }
      expect(p.totalMs).toBe(p.moves.reduce((s, m) => s + m.durMs, 0));
      expect(p.final).toBe(cupsAfter(p.moves, p.moves.length).indexOf(p.start));
      expect(p.ceiling).toBe(Math.max(...belief(p.start, p.moves)));
    }
    const expected = (['swap', 'rotate', 'overlap'] as const).filter((k) => sh.mix[k] > 0);
    expect([...kinds].sort()).toEqual([...expected].sort());
  });
});

describe('shuffle', () => {
  it.each(LEVEL_IDS)('① %s: renderer = logic at every move boundary (10,000 plans)', (level) => {
    const fails: string[] = [];
    for (const plan of plans(level, 10_000, 1)) {
      const times = moveTimes(plan);
      for (let k = 0; k <= plan.moves.length; k++) {
        const poses = cupPoses(plan, times[k], T);
        const cupAt = cupsAfter(plan.moves, k);
        for (const s of [0, 1, 2] as Slot[]) {
          const p = poses[cupAt[s]];
          if (p.cup !== cupAt[s] || p.y !== 0 || p.x !== SLOT_X[s]) fails.push(`k=${k} slot=${s} ${JSON.stringify(p)}`);
        }
      }
      if (cupPoses(plan, plan.totalMs, T)[plan.start].x !== SLOT_X[plan.final]) fails.push('final');
    }
    expect(fails.slice(0, 5)).toEqual([]);
  });

  it('cups move continuously and stay inside Y_RANGE (no teleport)', () => {
    let maxStep = 0, minY = 0, maxY = 0;
    for (const plan of plans('hardest', 300, 2)) {
      let prev = cupPoses(plan, 0, T);
      for (let t = 1; t <= plan.totalMs; t++) {
        const cur = cupPoses(plan, t, T);
        for (const c of [0, 1, 2]) {
          maxStep = Math.max(maxStep, Math.hypot(cur[c].x - prev[c].x, cur[c].y - prev[c].y));
          minY = Math.min(minY, cur[c].y);
          maxY = Math.max(maxY, cur[c].y);
        }
        prev = cur;
      }
    }
    expect(maxStep).toBeLessThan(0.05); // fastest path: ~0.03 slot per ms
    expect(minY).toBeGreaterThanOrEqual(Y_RANGE[0]);
    expect(maxY).toBeLessThanOrEqual(Y_RANGE[1]);
  });

  it('② hardest: every plan has ceiling <= cMax', () => {
    const cMax = CONFIG.levels.hardest.shuffle.cMax;
    const worst = Math.max(...plans('hardest', 10_000, 3).map((p) => p.ceiling));
    expect(worst).toBeLessThanOrEqual(cMax + 1e-12);
  });

  it('③ hardest: final slot is uniform whatever the start (chi-square < 16.81)', () => {
    const grid = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (const p of plans('hardest', 30_000, 4)) grid[p.start][p.final]++;
    let chi2 = 0;
    for (const row of grid) {
      const e = (row[0] + row[1] + row[2]) / 3;
      for (const x of row) chi2 += (x - e) ** 2 / e;
    }
    expect(chi2).toBeLessThan(16.81);
  });

  it.each([
    ['hardest', 50_000],
    ['normal', 20_000],
  ] as const)('④ %s: ideal observer hit rate = mean ceiling ± 4 SE', (level, n) => {
    let hits = 0, sumC = 0, varSum = 0;
    for (const p of plans(level, n, 5)) {
      if (argmax(belief(p.start, p.moves)) === p.final) hits++;
      sumC += p.ceiling;
      varSum += p.ceiling * (1 - p.ceiling);
    }
    const se = Math.sqrt(varSum) / n;
    expect(Math.abs(hits / n - sumC / n)).toBeLessThanOrEqual(4 * se);
  });

  describe('⑤ overlap: pass and bounce draw the same frames', () => {
    const pairs: [Slot, Slot][] = [[0, 1], [1, 2], [0, 2]];
    it.each(pairs)('single overlap(%i, %i) at 50 times', (a, b) => {
      for (const start of [0, 1, 2] as Slot[]) {
        const mk = (pass: boolean): Plan => {
          const moves: Move[] = [{ kind: 'overlap', a, b, pass, durMs: 300 }];
          const final = cupsAfter(moves, 1).indexOf(start) as Slot;
          return { level: 'normal', start, moves, final, ceiling: 0.5, totalMs: 300 };
        };
        const pass = mk(true), bounce = mk(false);
        for (let i = 0; i < 50; i++) {
          const t = (300 * i) / 49;
          expect(unordered(cupPoses(pass, t, T))).toEqual(unordered(cupPoses(bounce, t, T)));
        }
        // Not vacuous: the pair really meets, and the two outcomes really differ by cup.
        const mid = cupPoses(pass, 150, T);
        expect(mid[a].x).toBe(mid[b].x);
        expect(mid[a].y).toBe(mid[b].y);
        expect(mid[a].x).not.toBe(SLOT_X[a]);
        expect(cupPoses(pass, 300, T)[a].x).toBe(SLOT_X[b]);
        expect(cupPoses(bounce, 300, T)[a].x).toBe(SLOT_X[a]);
      }
    });

    it('stacking depends on position only: equal z only for cups at the same point', () => {
      let bad = 0;
      for (const plan of plans('hardest', 100, 11)) {
        for (let i = 0; i <= 200; i++) {
          const ps = cupPoses(plan, (plan.totalMs * i) / 200, T);
          for (const p of ps) {
            for (const q of ps) {
              if (p.cup === q.cup) continue;
              const same = p.x === q.x && p.y === q.y;
              const front = p.y > q.y || (p.y === q.y && p.x > q.x);
              if ((p.z === q.z) !== same || (!same && (p.z > q.z) !== front)) bad++;
            }
          }
        }
      }
      expect(bad).toBe(0);
    });

    it('whole hardest plans with every coin flipped look identical at every overlap', () => {
      const rng = seededRng(6);
      const fails: number[] = [];
      let checked = 0;
      const check = (a: Plan, b: Plan, t: number) => {
        checked++;
        if (JSON.stringify(unordered(cupPoses(a, t, T))) !== JSON.stringify(unordered(cupPoses(b, t, T)))) fails.push(t);
      };
      for (const plan of plans('hardest', 500, 7)) {
        const flipped = withCoins(plan, (i) => !(plan.moves[i] as { pass: boolean }).pass);
        const times = moveTimes(plan);
        plan.moves.forEach((m, k) => {
          if (m.kind === 'overlap') for (let i = 0; i < 50; i++) check(plan, flipped, times[k] + (m.durMs * i) / 49);
        });
        for (let i = 0; i < 50; i++) check(plan, flipped, rng.float() * plan.totalMs);
      }
      expect(fails.slice(0, 5)).toEqual([]);
      expect(checked).toBeGreaterThan(100_000);
    });
  });
});
