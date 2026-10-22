// The average 요트 다이스 player the paytable was tuned for (games/yacht/src/rules.ts: about 93%): keeps three or
// more of a kind, else a 4-straight, else a pair, else the 5s and 6s; on the next roll adds what fits what it
// kept. Plays the real rules: held dice lock, and at least one die rolls each time.
import { ROLLS, firstRollTilted, rollTilted, type Die, type RoundState } from '../../games/yacht/src/rules.ts';

type Counts = number[]; // counts[f]: dice showing f + 1

const RUNS = [
  [0, 1, 2, 3],
  [1, 2, 3, 4],
  [2, 3, 4, 5],
];

const countsOf = (dice: readonly number[]): Counts => {
  const c = [0, 0, 0, 0, 0, 0];
  for (const d of dice) c[d - 1]++;
  return c;
};
const size = (c: Counts): number => c.reduce((a, x) => a + x, 0);
const add = (a: Counts, b: Counts): Counts => a.map((x, i) => x + b[i]);

/** What to keep from these dice, at most `cap` of them. */
function pick(d: Counts, cap: number): Counts {
  const z = [0, 0, 0, 0, 0, 0];
  let best = -1;
  let bf = -1;
  for (let f = 5; f >= 0; f--)
    if (d[f] > best) {
      best = d[f];
      bf = f;
    }
  if (best >= 3) {
    z[bf] = Math.min(best, cap);
    return z;
  }
  if (cap >= 4)
    for (const r of [...RUNS].reverse())
      if (r.every((f) => d[f] >= 1)) {
        r.forEach((f) => (z[f] = 1));
        return z;
      }
  if (best === 2) {
    z[bf] = Math.min(2, cap);
    return z;
  }
  z[4] = Math.min(d[4], cap);
  z[5] = Math.min(d[5], cap - z[4]);
  return z;
}

/** Adds to the locked dice `l` from the free ones `f`, at most 4 kept in all. */
function extend(l: Counts, f: Counts): Counts {
  const cap = 4 - size(l);
  if (cap <= 0) return l;
  if (size(l) === 0) return pick(f, cap);
  const faces = l.map((x, i) => (x ? i : -1)).filter((i) => i >= 0);
  const k = [0, 0, 0, 0, 0, 0];
  if (faces.length === 1 && l[faces[0]] >= 2) {
    k[faces[0]] = Math.min(f[faces[0]], cap); // more of the same
    return add(l, k);
  }
  if (faces.length >= 3 && l.every((x) => x <= 1)) {
    // a run: the faces that would make the straight
    const lo = Math.min(...faces);
    const hi = Math.max(...faces);
    let left = cap;
    for (let x = 0; x < 6; x++)
      if (left > 0 && !l[x] && f[x] && x >= Math.max(0, hi - 4) && x <= Math.min(5, lo + 4)) {
        k[x] = 1;
        left--;
      }
    return add(l, k);
  }
  if (faces.every((x) => x >= 4)) {
    let left = cap;
    for (const x of [5, 4]) {
      const n = Math.min(f[x], left);
      k[x] = n;
      left -= n;
    }
    return add(l, k);
  }
  k[faces[0]] = Math.min(f[faces[0]], cap);
  return add(l, k);
}

/** Marks dice to hold so that the kept dice (locked + held) match `keep`. */
function holdFor(s: RoundState, keep: Counts): RoundState {
  const want = keep.slice();
  const held = s.dice.map((_, i) => s.locked[i]);
  s.dice.forEach((d, i) => {
    if (s.locked[i]) want[d - 1]--;
  });
  s.dice.forEach((d, i) => {
    if (!held[i] && want[d - 1] > 0) {
      held[i] = true;
      want[d - 1]--;
    }
  });
  return { ...s, held };
}

/** Plays one round like the average guest, each roll kept with chance `keep(multiplier)`; returns the final five dice. */
export function averageYachtRound(int: (n: number) => number, keep: (mult: number) => number = () => 1): Die[] {
  let s = firstRollTilted(keep, int);
  s = rollTilted(holdFor(s, pick(countsOf(s.dice), 4)), keep, int);
  while (s.rolls < ROLLS) {
    const locked = countsOf(s.dice.filter((_, i) => s.locked[i]));
    const free = countsOf(s.dice.filter((_, i) => !s.locked[i]));
    s = rollTilted(holdFor(s, extend(locked, free)), keep, int);
  }
  return s.dice;
}
