// Game randomness: crypto.getRandomValues with rejection sampling, so every outcome is exactly as likely as its weight.

const TWO_32 = 0x1_0000_0000;
const buf = new Uint32Array(64);
let at = buf.length;

function u32(): number {
  if (at === buf.length) {
    crypto.getRandomValues(buf);
    at = 0;
  }
  return buf[at++];
}

/** Uniform integer in [0, n). */
export function randomInt(n: number): number {
  if (!Number.isInteger(n) || n < 1 || n > TWO_32) throw new RangeError(`randomInt: bad n ${n}`);
  const limit = TWO_32 - (TWO_32 % n);
  for (;;) {
    const v = u32();
    if (v < limit) return v % n;
  }
}

/** Index i with probability weights[i] / Σweights (integer weights). */
export function weighted(weights: readonly number[], int: (n: number) => number = randomInt): number {
  const total = weights.reduce((a, w) => a + w, 0);
  let r = int(total);
  for (let i = 0; i < weights.length; i++) {
    r -= weights[i];
    if (r < 0) return i;
  }
  throw new Error('weighted: empty table');
}

/** Fisher–Yates on a copy. */
export function shuffled<T>(items: readonly T[], int: (n: number) => number = randomInt): T[] {
  const a = items.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = int(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Draws for one result of the 승리 추세 at most (the last one stands). */
export const TILT_TRIES = 64;

/** 승리 추세 (sdk/casino.ts keepChance): draws again until a result is kept, `keep(result)` being its chance. */
export function tiltedDraw<T>(draw: () => T, keep: (r: T) => number, int: (n: number) => number = randomInt): T {
  let r = draw();
  for (let n = 1; n < TILT_TRIES && int(1_000_000) >= keep(r) * 1_000_000; n++) r = draw();
  return r;
}

/** Cosmetic randomness (animation jitter, confetti): not for outcomes. */
export const jitter = (a: number, b: number): number => a + Math.random() * (b - a);
