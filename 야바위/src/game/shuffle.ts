// Shuffle plan: the one source for both the answer (applyMove) and the animation (cupPoses). Pure.
import type { GameConfig, LevelId, ShuffleConfig, TimingConfig } from '../config';
import type { Rng } from '../rng';

export type Slot = 0 | 1 | 2; // position, left to right
export type CupId = 0 | 1 | 2; // physical cup; cup i starts at slot i; the ball is in cup `start`
export type Move =
  | { kind: 'swap'; a: Slot; b: Slot; durMs: number } // cups at slots a and b trade slots
  | { kind: 'rotate'; dir: 1 | 2; durMs: number } // cup at slot i moves to slot (i + dir) % 3
  | { kind: 'overlap'; a: Slot; b: Slot; pass: boolean; durMs: number }; // pass: same as swap; else both return
export interface Plan {
  level: LevelId;
  start: Slot;
  moves: Move[];
  final: Slot; // slot of cup `start` after folding applyMove over every move
  ceiling: number; // max of belief(start, moves)
  totalMs: number; // sum of durMs; move k runs from t_k to t_{k+1}
}
export interface Pose {
  cup: CupId;
  x: number;
  y: number;
  z: number;
} // z derived from (y, x) only

/** x of each slot when cups are at rest. Units: one slot spacing. y = 0 at rest; y > 0 is toward the player. */
export const SLOT_X: readonly [number, number, number] = [-1, 0, 1];

/** Path depths in slot units. */
export const ARC = {
  swapNear: 0.32, // adjacent swap: one cup arcs in front, the other behind
  swapFar: 0.55, // end-to-end swap: deeper so both clear the middle cup
  rotateWrap: 0.7, // rotate: the end-to-end cup's big front arc
  rotateShift: -0.12, // rotate: the two one-step cups dip slightly back
  overlapFar: 0.5, // end-cup overlap: meeting point this far in front of the middle cup
} as const;
/** Every pose has Y_RANGE[0] <= y <= Y_RANGE[1]. */
export const Y_RANGE: readonly [number, number] = [-ARC.swapFar, ARC.rotateWrap];

const SLOTS: readonly Slot[] = [0, 1, 2];
const PAIRS: readonly (readonly [Slot, Slot])[] = [[0, 1], [1, 2], [0, 2]];
const CMAX_EPS = 1e-12;
const MAX_TRIES = 100_000;

// ---------------------------------------------------------------- logic

/** The only permutation rule. cupAt[slot] = cup. Returns a new array. */
export function applyMove(cupAt: readonly CupId[], m: Move): CupId[] {
  const next = cupAt.slice();
  if (m.kind === 'swap' || (m.kind === 'overlap' && m.pass)) {
    next[m.a] = cupAt[m.b];
    next[m.b] = cupAt[m.a];
  } else if (m.kind === 'rotate') {
    for (const i of SLOTS) next[(i + m.dir) % 3] = cupAt[i];
  }
  return next;
}

/** cupAt after the first k moves (k = moves.length: the final arrangement). */
export function cupsAfter(moves: readonly Move[], k: number): CupId[] {
  let cupAt: CupId[] = [0, 1, 2];
  for (let i = 0; i < k && i < moves.length; i++) cupAt = applyMove(cupAt, moves[i]);
  return cupAt;
}

/** Ideal observer's posterior over slots: swap and rotate permute it, overlap averages the pair. Ignores coins. */
export function belief(start: Slot, moves: readonly Move[]): [number, number, number] {
  let p: [number, number, number] = [0, 0, 0];
  p[start] = 1;
  for (const m of moves) {
    if (m.kind === 'swap') [p[m.a], p[m.b]] = [p[m.b], p[m.a]];
    else if (m.kind === 'rotate') {
      const q: [number, number, number] = [0, 0, 0];
      for (const i of SLOTS) q[(i + m.dir) % 3] = p[i];
      p = q;
    } else {
      const avg = (p[m.a] + p[m.b]) / 2;
      p[m.a] = avg;
      p[m.b] = avg;
    }
  }
  return p;
}

function drawMoves(sh: ShuffleConfig, overlapMsMult: number, rng: Rng): Move[] {
  const n = sh.moves[0] + rng.int(sh.moves[1] - sh.moves[0] + 1);
  const { swap, rotate, overlap } = sh.mix;
  const total = swap + rotate + overlap;
  const moves: Move[] = [];
  for (let k = 0; k < n; k++) {
    const r = rng.float() * total;
    const durMs = sh.moveMs[0] + rng.int(sh.moveMs[1] - sh.moveMs[0] + 1);
    if (r < overlap) {
      const [a, b] = PAIRS[rng.int(3)];
      moves.push({ kind: 'overlap', a, b, pass: false, durMs: Math.round(durMs * overlapMsMult) });
    } else if (r < overlap + rotate) {
      moves.push({ kind: 'rotate', dir: rng.coin() ? 1 : 2, durMs });
    } else {
      const [a, b] = PAIRS[rng.int(3)];
      moves.push({ kind: 'swap', a, b, durMs });
    }
  }
  return moves;
}

/**
 * Draws start, then moves until max(belief) <= cMax (only visible information decides acceptance),
 * then the overlap coins, then the answer.
 */
export function generatePlan(level: LevelId, cfg: GameConfig, rng: Rng): Plan {
  const sh: ShuffleConfig = cfg.levels[level].shuffle;
  const start = rng.int(3) as Slot;
  for (let tries = 1; tries <= MAX_TRIES; tries++) {
    const moves = drawMoves(sh, cfg.timing.overlapMsMult, rng);
    const ceiling = Math.max(...belief(start, moves));
    if (sh.cMax != null && ceiling > sh.cMax + CMAX_EPS) continue;
    for (const m of moves) if (m.kind === 'overlap') m.pass = rng.coin();
    const final = cupsAfter(moves, moves.length).indexOf(start) as Slot;
    const totalMs = moves.reduce((s, m) => s + m.durMs, 0);
    return { level, start, moves, final, ceiling, totalMs };
  }
  throw new Error(`cMax unreachable with the ${level} shuffle config`);
}

/** t_0 .. t_n: move k runs from times[k] to times[k + 1]; times[n] = totalMs. */
export function moveTimes(plan: Plan): number[] {
  const times = [0];
  for (const m of plan.moves) times.push(times[times.length - 1] + m.durMs);
  return times;
}

// ---------------------------------------------------------------- animation

/**
 * Stacking rank 0..2 from position only: front (larger y) on top, then larger x.
 * Cups at exactly the same point share a rank, so cup id never decides what is drawn.
 */
function stack(out: Out): Out {
  for (const p of out) {
    p.z = out.filter((q) => q.y < p.y || (q.y === p.y && q.x < p.x)).length;
  }
  return out;
}

const ease = (u: number): number => 0.5 - 0.5 * Math.cos(Math.PI * u);

type Out = Pose[];
const put = (out: Out, cup: CupId, x: number, y: number): void => {
  out[cup] = { cup, x, y, z: 0 };
};

function rest(cupAt: readonly CupId[]): Pose[] {
  const out: Out = [];
  for (const s of SLOTS) put(out, cupAt[s], SLOT_X[s], 0);
  return out;
}

/** From slot `from` to slot `to` along a sine arc of depth h; e is eased progress in [0, 1]. */
function arc(out: Out, cup: CupId, from: Slot, to: Slot, h: number, e: number): void {
  put(out, cup, SLOT_X[from] + (SLOT_X[to] - SLOT_X[from]) * e, h * Math.sin(Math.PI * e));
}

/** Neighbours meet halfway; the end cups meet in front of the middle cup. */
function overlapMeet(a: Slot, b: Slot): { x: number; y: number } {
  const x = (SLOT_X[a] + SLOT_X[b]) / 2;
  return Math.abs(a - b) === 2 ? { x, y: ARC.overlapFar } : { x, y: 0 };
}

function movePoses(cupAt: readonly CupId[], m: Move, ms: number, timing: TimingConfig): Pose[] {
  const out: Out = rest(cupAt);
  if (m.kind === 'swap') {
    const e = ease(ms / m.durMs);
    const lo = Math.min(m.a, m.b) as Slot, hi = Math.max(m.a, m.b) as Slot;
    const h = hi - lo === 2 ? ARC.swapFar : ARC.swapNear;
    arc(out, cupAt[lo], lo, hi, h, e); // rightward cup in front
    arc(out, cupAt[hi], hi, lo, -h, e); // leftward cup behind
  } else if (m.kind === 'rotate') {
    const e = ease(ms / m.durMs);
    for (const s of SLOTS) {
      const to = ((s + m.dir) % 3) as Slot;
      arc(out, cupAt[s], s, to, Math.abs(to - s) === 2 ? ARC.rotateWrap : ARC.rotateShift, e);
    }
  } else {
    // Slide in, dwell fully coincident, slide out along the mirror of the way in.
    // The two leg positions are computed identically for pass and bounce; `pass` only decides which cup
    // takes which leg on the way out, so every frame is the same unordered set of poses.
    const dwell = Math.min(timing.overlapDwellMs, m.durMs);
    const slide = (m.durMs - dwell) / 2;
    const meet = overlapMeet(m.a, m.b);
    let e: number; // 0 at the home slot, 1 at the meeting point
    if (slide <= 0 || (ms >= slide && ms < slide + dwell)) e = 1;
    else if (ms < slide) e = ease(ms / slide);
    else e = ease((m.durMs - ms) / slide);
    const leg = (s: Slot): [number, number] =>
      e === 1 ? [meet.x, meet.y] : [SLOT_X[s] + (meet.x - SLOT_X[s]) * e, meet.y * e];
    const crossed = m.pass && ms >= slide + dwell;
    const [ax, ay] = leg(m.a), [bx, by] = leg(m.b);
    put(out, crossed ? cupAt[m.b] : cupAt[m.a], ax, ay);
    put(out, crossed ? cupAt[m.a] : cupAt[m.b], bx, by);
  }
  return out;
}

/**
 * Pose of every cup at time tMs (index = cup id). The renderer draws only this.
 * At every move boundary t_k each cup is at rest (y = 0) at SLOT_X of its slot after k moves.
 */
export function cupPoses(plan: Plan, tMs: number, timing: TimingConfig): Pose[] {
  let cupAt: CupId[] = [0, 1, 2];
  let t0 = 0;
  for (const m of plan.moves) {
    if (tMs < t0 + m.durMs) return stack(tMs <= t0 ? rest(cupAt) : movePoses(cupAt, m, tMs - t0, timing));
    cupAt = applyMove(cupAt, m);
    t0 += m.durMs;
  }
  return stack(rest(cupAt));
}
