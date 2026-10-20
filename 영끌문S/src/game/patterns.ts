// Chart formations (DESIGN.md section 2): the shapes of a chart-pattern guide (wedges, triangles, rectangles,
// head and shoulders, cup and handle, flags, double tops) and the bubble cycle, played onto the price one after
// another. A formation is a list of key points (time 0..1, height in units of the formation's size); the price
// follows straight lines between them, with the noise on top.
//
// None of it is a signal. Each formation is mirrored at random (a falling wedge or a rising one, a head and
// shoulders or its inverse), its points are jittered, it sometimes stops early, and it breaks out in a random
// direction: on average a formation moves the price nowhere and its shape says nothing about the breakout.
// The bubble climbs, peaks, crashes below where it started and comes back to it.
import type { PatternDef, Range } from '../config.ts';
import { between, type Rng } from '../rng.ts';

type Points = readonly (readonly [number, number])[];

/** Drawn as in the guide (the bullish version); half of them come out mirrored. */
export const FORMATIONS: Readonly<Record<string, Points>> = {
  // 하락 쐐기 (mirrored: 상승 쐐기)
  wedge: [[0, 1], [0.12, 0.2], [0.24, 0.75], [0.38, -0.05], [0.5, 0.45], [0.62, -0.25], [0.74, 0.15], [0.86, -0.35], [0.95, -0.1]],
  // 대칭 삼각형
  triangle: [[0, 0], [0.12, 1], [0.25, -0.8], [0.38, 0.62], [0.5, -0.45], [0.62, 0.32], [0.73, -0.2], [0.83, 0.1], [0.92, -0.02]],
  // 상승 직사각형 (mirrored: 하락 직사각형)
  rectangle: [[0, -1], [0.12, 0.6], [0.22, -0.3], [0.34, 0.6], [0.46, -0.3], [0.58, 0.6], [0.7, -0.3], [0.82, 0.6], [0.9, 0.15]],
  // 역헤드앤숄더 (mirrored: 헤드앤숄더)
  headShoulders: [[0, 0.4], [0.14, -0.45], [0.26, 0.2], [0.42, -1], [0.58, 0.2], [0.72, -0.45], [0.86, 0.2]],
  // 컵앤핸들 (mirrored: 역컵앤핸들)
  cupHandle: [[0, 0.8], [0.1, 0.35], [0.22, -0.35], [0.35, -0.7], [0.48, -0.4], [0.6, 0.3], [0.7, 0.8], [0.8, 0.45], [0.9, 0.65]],
  // 상승 삼각형 (mirrored: 하락 삼각형)
  ascending: [[0, -1], [0.14, 0.8], [0.28, -0.55], [0.42, 0.8], [0.56, -0.2], [0.7, 0.8], [0.82, 0.25], [0.92, 0.8]],
  // 역깃발 (mirrored: 깃발)
  flag: [[0, 1], [0.18, -0.7], [0.28, -0.4], [0.36, -0.6], [0.48, -0.25], [0.56, -0.45], [0.68, -0.1], [0.76, -0.3], [0.86, 0]],
  // 쌍봉 (mirrored: 쌍바닥)
  doubleTop: [[0, -0.8], [0.22, 0.9], [0.42, -0.05], [0.62, 0.9], [0.82, -0.05], [0.9, -0.2]],
};

/** 버블의 단계: 스텔스 → 1차 하락 → 언론·대중 → 열정·탐욕·환상 → 정점 → 현실 부정 → 공포·투매 → 좌절 → 정상화. */
export const BUBBLE: Points = [
  [0, 0], [0.1, 0.12], [0.16, 0.18], [0.21, 0.08], [0.3, 0.22], [0.38, 0.32], [0.45, 0.45], [0.51, 0.62], [0.56, 0.82],
  [0.6, 1], [0.64, 0.72], [0.67, 0.86], [0.72, 0.55], [0.77, 0.2], [0.82, -0.15], [0.87, -0.3], [0.94, -0.12], [1, 0],
];

const JITTER = 0.15; // of the height, per key point
const BUBBLE_JITTER = 0.05;
const SIZE: Range = [0.7, 1.3]; // spread of a formation's size
const ABORT = 0.25; // chance a formation breaks out before it is complete
const ABORT_AT: Range = [0.45, 0.9];
const BREAKOUT: Range = [0.6, 1.4]; // in units of the formation's size
const BREAKOUT_SHARE = 0.12; // of the formation's length

/** Per-tick log-price changes of one stock's formations: plain stretches and formations, one after another. */
export function makePatterns(def: PatternDef, rng: Rng, dt: number): () => number {
  const names = Object.keys(FORMATIONS);
  const idle = def.amp <= 0 && def.bubble <= 0;
  let wait = Math.round(between(rng, def.gapSec) / dt);
  let steps: Float64Array | null = null;
  let i = 0;

  const build = (): Float64Array => {
    const bubble = rng.float() < def.bubble;
    const sec = between(rng, bubble ? def.bubbleSec : def.sec);
    const size = (bubble ? def.bubbleAmp : def.amp * Math.sqrt(sec / 60)) * between(rng, SIZE);
    const jitter = bubble ? BUBBLE_JITTER : JITTER;
    let pts = (bubble ? BUBBLE : FORMATIONS[names[rng.int(names.length)]]).map(
      ([t, y]): [number, number] => [t, y + (2 * rng.float() - 1) * jitter],
    );
    if (!bubble) {
      if (rng.float() < ABORT) pts = cut(pts, between(rng, ABORT_AT));
      const [t, y] = pts[pts.length - 1];
      pts.push([t + BREAKOUT_SHARE, y + (rng.coin() ? 1 : -1) * between(rng, BREAKOUT)]);
    }
    const scale = (bubble || rng.coin() ? 1 : -1) * size; // the bubble always goes up first
    const n = Math.max(2, Math.round((pts[pts.length - 1][0] * sec) / dt));
    const out = new Float64Array(n);
    let prev = 0;
    for (let k = 0; k < n; k++) {
      const y = (at(pts, ((k + 1) / n) * pts[pts.length - 1][0]) - pts[0][1]) * scale;
      out[k] = y - prev;
      prev = y;
    }
    return out;
  };

  return () => {
    if (steps) {
      const d = steps[i++];
      if (i >= steps.length) {
        steps = null;
        wait = Math.round(between(rng, def.gapSec) / dt);
      }
      return d;
    }
    if (idle || --wait > 0) return 0;
    steps = build();
    i = 0;
    return 0;
  };
}

/** Height at time t, on straight lines between the key points. */
function at(pts: Points, t: number): number {
  if (t <= pts[0][0]) return pts[0][1];
  for (let k = 1; k < pts.length; k++) {
    const [t1, y1] = pts[k];
    if (t <= t1) {
      const [t0, y0] = pts[k - 1];
      return y0 + ((y1 - y0) * (t - t0)) / (t1 - t0 || 1);
    }
  }
  return pts[pts.length - 1][1];
}

/** The key points up to time t, ending exactly at t. */
function cut(pts: [number, number][], t: number): [number, number][] {
  const kept = pts.filter(([pt]) => pt < t);
  kept.push([t, at(pts, t)]);
  return kept;
}
