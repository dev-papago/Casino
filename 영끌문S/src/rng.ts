export interface Rng {
  int(n: number): number; // uniform integer in [0, n)
  float(): number; // uniform in [0, 1)
  coin(): boolean;
}

/** A source of uniform 32-bit unsigned integers. */
export type U32Source = () => number;

const TWO_32 = 0x1_0000_0000;

/** Builds an Rng on any u32 source; `int` uses rejection sampling so every value is exactly equally likely. */
export function rngFromSource(next: U32Source): Rng {
  const int = (n: number): number => {
    if (!Number.isInteger(n) || n < 1 || n > TWO_32) throw new RangeError(`int(n): bad n ${n}`);
    const limit = TWO_32 - (TWO_32 % n);
    for (;;) {
      const v = next() >>> 0;
      if (v < limit) return v % n;
    }
  };
  return {
    int,
    float: () => (next() >>> 0) / TWO_32,
    coin: () => int(2) === 1,
  };
}

/** The game RNG: crypto.getRandomValues, buffered. */
export function cryptoRng(): Rng {
  const buf = new Uint32Array(256);
  let i = buf.length;
  return rngFromSource(() => {
    if (i === buf.length) {
      crypto.getRandomValues(buf);
      i = 0;
    }
    return buf[i++];
  });
}

/** Deterministic RNG for tests only (splitmix32-seeded sfc32, same family as scripts/simulate.mjs). */
export function seededRng(seed: number): Rng {
  let s = seed | 0;
  const sm = () => {
    s = (s + 0x9e3779b9) | 0;
    let t = s ^ (s >>> 16);
    t = Math.imul(t, 0x21f0aaad);
    t ^= t >>> 15;
    t = Math.imul(t, 0x735a2d97);
    t ^= t >>> 15;
    return t >>> 0;
  };
  let a = sm(), b = sm(), c = sm(), d = sm();
  return rngFromSource(() => {
    let t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    t = (t + d) | 0;
    c = (c + t) | 0;
    return t >>> 0;
  });
}

/** Standard normal sample (Box-Muller). */
export function gauss(rng: Rng): number {
  const u = 1 - rng.float(); // (0, 1]
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng.float());
}

/** Uniform in [lo, hi]. */
export const between = (rng: Rng, [lo, hi]: readonly [number, number]): number => lo + (hi - lo) * rng.float();
