// 플링코 boards. The landing slot is drawn from integer weights (out of 1,000,000) when the ball is dropped; the
// ball then falls along a path that ends there, so the animation only shows the draw. Integer multipliers, so the
// return is exact at every stake: Σ weight × multiplier = 860,000 on every board (RTP 86%: a luck game, below the
// skill games; the platform's chip economy is in src/shared/config.ts).
// The weights keep the feel of the old physics board (edges much likelier than a pure binomial).
import type { Tilt } from '../../../sdk/casino.ts';
import { randomInt, shuffled, tiltedDraw, weighted } from '../../arcade/rng.ts';

export type BoardId = 'easy' | 'medium' | 'hard';

export interface Board {
  label: string;
  rows: number; // peg rows; slots = rows + 1
  mults: readonly number[]; // left to right
  weights: readonly number[]; // per 1,000,000
}

export const BOARDS: Record<BoardId, Board> = {
  // 자주 조금: 52% get something back, the edges pay 4x about 1 in 12.
  easy: {
    label: '쉬움',
    rows: 10,
    mults: [4, 2, 1, 1, 0, 0, 0, 1, 1, 2, 4],
    weights: [43119, 42353, 72163, 100654, 157722, 167976, 157722, 100654, 72165, 42353, 43119],
  },
  // 1 in 4.5 pays, 8x on either edge about 1 in 15.
  medium: {
    label: '보통',
    rows: 12,
    mults: [8, 4, 1, 0, 0, 0, 0, 0, 0, 0, 1, 4, 8],
    weights: [33347, 26858, 55795, 81029, 107711, 127898, 134730, 127898, 107711, 81029, 55789, 26858, 33347],
  },
  // 가끔 크게: 85% lose; 25x on either side about 1 in 110, 50x on the far right about 1 in 570.
  hard: {
    label: '어려움',
    rows: 14,
    mults: [1, 25, 6, 1, 0, 0, 0, 0, 0, 0, 0, 1, 6, 25, 50],
    weights: [9625, 8853, 20058, 39409, 79508, 115875, 147495, 166204, 147495, 115875, 79508, 39420, 20058, 8853, 1764],
  },
};

export const BOARD_IDS = Object.keys(BOARDS) as BoardId[];

export const drawSlot = (b: Board, int: (n: number) => number = randomInt): number => weighted(b.weights, int);

/**
 * 승리 추세 (sdk/casino.ts), tuned with the 확률 시뮬레이터 for a bold guest (half to all of the balance a round,
 * 17 minutes): about 3% end broke, most with 5–19 chips, about 3% reach 50; 9.6 chips on average.
 */
export const PLINKO_TILT: Tilt = { center: 7, left: 8, right: 2, bust: 16 };

/** The landing slot with the 승리 추세: `keep(multiplier)` is the chance to keep a slot. */
export function drawSlotTilted(b: Board, keep: (mult: number) => number, int: (n: number) => number = randomInt): number {
  return tiltedDraw(() => drawSlot(b, int), (slot) => keep(b.mults[slot]), int);
}

/** The bounce at each peg row (true = right) for a ball that ends in `slot`: `slot` rights in random order. */
export const pathTo = (b: Board, slot: number, int: (n: number) => number = randomInt): boolean[] =>
  shuffled(
    Array.from({ length: b.rows }, (_, i) => i < slot),
    int,
  );
