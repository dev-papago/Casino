// 슬롯머신 reels and paytable. Each reel is a strip of 20 stops with its own mix of symbols (weighted reels, as in
// real machines); a spin picks one stop per reel uniformly. 20³ = 8,000 equally likely results, and the paytable
// returns exactly 7,800 stakes over them (97.5%). On top, the machine is "tight" (MIX): 7,040 of every 7,800
// spins are such a fair spin and the rest land on a losing line, so the RTP is exactly 88% at every stake (a luck
// game, below the skill games), before the 승리 추세 (spinTilted).
import type { Tilt } from '../../../sdk/casino.ts';
import { randomInt, tiltedDraw } from '../../arcade/rng.ts';

export type Sym = '7' | '🔔' | '🍀' | '🍋' | '🍒';
export const SYMBOLS: readonly Sym[] = ['7', '🔔', '🍀', '🍋', '🍒'];

/** Stops per symbol on each reel (each reel sums to 20). */
export const REEL_MIX: readonly Record<Sym, number>[] = [
  { '7': 1, '🔔': 3, '🍀': 9, '🍋': 2, '🍒': 5 },
  { '7': 2, '🔔': 2, '🍀': 3, '🍋': 3, '🍒': 10 },
  { '7': 2, '🔔': 3, '🍀': 1, '🍋': 12, '🍒': 2 },
];

/** Multiplier of the stake (the stake included) for three or exactly two of a symbol. */
export const TRIPLE: Record<Sym, number> = { '7': 50, '🔔': 20, '🍀': 14, '🍋': 11, '🍒': 5 };
export const PAIR: Record<Sym, number> = { '7': 7, '🔔': 2, '🍀': 2, '🍋': 1, '🍒': 1 };

/** The strips in a fixed order that spreads each symbol out (so the reel looks mixed while it spins). */
export const STRIPS: readonly (readonly Sym[])[] = REEL_MIX.map((mix) => spread(mix));

function spread(mix: Record<Sym, number>): Sym[] {
  // Largest-remainder interleave: place each symbol's stops evenly around the strip.
  const n = SYMBOLS.reduce((a, s) => a + mix[s], 0);
  const slots: [number, Sym][] = [];
  for (const s of SYMBOLS) for (let k = 0; k < mix[s]; k++) slots.push([(k + 0.5) / mix[s] + SYMBOLS.indexOf(s) * 0.013, s]);
  slots.sort((a, b) => a[0] - b[0]);
  if (slots.length !== n) throw new Error('strip');
  return slots.map((x) => x[1]);
}

export interface Win {
  mult: number;
  label: string;
  sym: Sym | null;
  count: 0 | 2 | 3;
}

export function evaluate(line: readonly Sym[]): Win {
  const count = new Map<Sym, number>();
  for (const s of line) count.set(s, (count.get(s) ?? 0) + 1);
  for (const [s, c] of count) if (c === 3) return { mult: TRIPLE[s], label: s === '7' ? '777 잭팟!' : `${s}${s}${s}`, sym: s, count: 3 };
  for (const [s, c] of count) if (c === 2) return { mult: PAIR[s], label: `${s}${s}`, sym: s, count: 2 };
  return { mult: 0, label: '꽝', sym: null, count: 0 };
}

/**
 * How the machine is set: out of every `of` spins, `fair` are fair draws (97.5%), `win` land on a uniformly chosen
 * paying line (they pay 7,800 stakes over 3,838 lines) and the rest on a uniformly chosen losing line.
 */
export const MIX = { fair: 7040, win: 0, of: 7800 }; // 88%

/** Every stop combination, split by whether it pays. */
const ALL: number[][] = [];
for (let a = 0; a < 20; a++) for (let b = 0; b < 20; b++) for (let c = 0; c < 20; c++) ALL.push([a, b, c]);
const pays = (s: number[]): boolean => evaluate([STRIPS[0][s[0]], STRIPS[1][s[1]], STRIPS[2][s[2]]]).mult > 0;
export const LOSING: readonly number[][] = ALL.filter((s) => !pays(s));
export const WINNING: readonly number[][] = ALL.filter(pays);

/** One spin: the stop index on each strip. */
export function spin(int: (n: number) => number = randomInt): number[] {
  const u = int(MIX.of);
  if (u < MIX.fair) return STRIPS.map((s) => int(s.length));
  if (u < MIX.fair + MIX.win) return WINNING[int(WINNING.length)].slice();
  return LOSING[int(LOSING.length)].slice();
}

/**
 * 승리 추세 (sdk/casino.ts), tuned with the 확률 시뮬레이터 for a bold guest: about 2% end broke, most with
 * 5–19 chips, about 2.5% reach 50; 10.7 chips on average.
 */
export const SLOT_TILT: Tilt = { center: 7, left: 8, right: 1.5, bust: 10 };

/** A spin with the 승리 추세: `keep(multiplier)` is the chance to keep a line. */
export function spinTilted(keep: (mult: number) => number, int: (n: number) => number = randomInt): number[] {
  return tiltedDraw(() => spin(int), (stops) => keep(evaluate(lineAt(stops)).mult), int);
}

/** Exact return of the machine as set. */
export const slotRtp = (): number => (MIX.fair * (7800 / 8000) + MIX.win * (7800 / 3838)) / MIX.of;

export const lineAt = (stops: readonly number[]): Sym[] => stops.map((i, r) => STRIPS[r][i]);
