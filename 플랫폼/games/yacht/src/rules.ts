// 요트 다이스 rules and paytable. A round: roll all five dice, then twice more. Before each re-roll the player
// holds dice; a die held for a roll stays locked for the rest of the round, and at least one die must roll each
// time (no standing pat). The final five dice pay one hand, multiplier of the stake (the stake included):
//   요트 (five of a kind) ×20 · 스트레이트 (1-2-3-4-5 or 2-3-4-5-6) ×2 · otherwise the sum, by distance from the
//   middle: 29 or more / 6 or less ×6, 28 / 7 ×2, 26–27 / 8–9 ×1 (stake back), anything else (10–25) ×0.
// RTP 93% for an average player (holds the biggest group, a 4-straight, else the high dice), exact enumeration;
// a perfect player gets about 104%: a skill game pays better than the luck games (86–88%).
import type { Tilt } from '../../../sdk/casino.ts';
import { randomInt, tiltedDraw } from '../../arcade/rng.ts';

export type Die = 1 | 2 | 3 | 4 | 5 | 6;

export interface Hand {
  key: 'yacht' | 'straight' | 'high6' | 'high2' | 'push' | 'none';
  name: string;
  mult: number;
}

export const ROLLS = 3;

export const PAYTABLE: readonly { key: Hand['key']; name: string; when: string; mult: number }[] = [
  { key: 'yacht', name: '요트', when: '다섯 개 모두 같은 눈', mult: 20 },
  { key: 'straight', name: '스트레이트', when: '1-2-3-4-5 또는 2-3-4-5-6', mult: 2 },
  { key: 'high6', name: '극단 합', when: '합 29 이상 또는 6 이하', mult: 6 },
  { key: 'high2', name: '높은/낮은 합', when: '합 28 또는 7', mult: 2 },
  { key: 'push', name: '본전', when: '합 26~27 또는 8~9', mult: 1 },
  { key: 'none', name: '꽝', when: '합 10~25', mult: 0 },
];

const entry = (key: Hand['key']) => PAYTABLE.find((p) => p.key === key)!;

export function evaluate(dice: readonly number[]): Hand {
  const sorted = [...dice].sort((a, b) => a - b).join('');
  const sum = dice.reduce((a, d) => a + d, 0);
  const pick = (key: Hand['key'], name?: string): Hand => ({ key, name: name ?? entry(key).name, mult: entry(key).mult });
  if (dice.every((d) => d === dice[0])) return pick('yacht', `요트 (${dice[0]})`);
  if (sorted === '12345' || sorted === '23456') return pick('straight');
  const far = Math.max(sum, 35 - sum); // 29 ↔ 6, 28 ↔ 7, …
  if (far >= 29) return pick('high6', `합 ${sum}`);
  if (far === 28) return pick('high2', `합 ${sum}`);
  if (far >= 26) return pick('push', `합 ${sum} · 본전`);
  return pick('none', `합 ${sum}`);
}

export const rollDie = (int: (n: number) => number = randomInt): Die => (int(6) + 1) as Die;

export interface RoundState {
  dice: Die[];
  held: boolean[]; // chosen for the next roll
  locked: boolean[]; // held for an earlier roll: cannot be released
  rolls: number; // rolls done (1..3)
}

/** Dice that will stay for the next roll. */
export const keeps = (s: RoundState): boolean[] => s.dice.map((_, i) => s.locked[i] || s.held[i]);

/** True when the next roll is allowed: rolls left and at least one die free to roll. */
export const canRoll = (s: RoundState): boolean => s.rolls < ROLLS && keeps(s).some((k) => !k);

/** The next roll: the kept dice lock, the others get new values. */
export function roll(s: RoundState, int: (n: number) => number = randomInt): RoundState {
  if (!canRoll(s)) throw new Error('no roll left');
  const keep = keeps(s);
  return {
    dice: s.dice.map((d, i) => (keep[i] ? d : rollDie(int))),
    held: keep.slice(),
    locked: keep.slice(),
    rolls: s.rolls + 1,
  };
}

export function firstRoll(int: (n: number) => number = randomInt): RoundState {
  return { dice: Array.from({ length: 5 }, () => rollDie(int)), held: [false, false, false, false, false], locked: [false, false, false, false, false], rolls: 1 };
}

/** The first roll with the 승리 추세 (see rollTilted). */
export function firstRollTilted(keep: (mult: number) => number, int: (n: number) => number = randomInt): RoundState {
  return tiltedDraw(() => firstRoll(int), (s) => keep(evaluate(s.dice).mult), int);
}

/**
 * 승리 추세 (sdk/casino.ts), tuned with the 확률 시뮬레이터 for a bold average player: about 10% end broke (held
 * dice can leave no way out), most with 5–19 chips, about 4% reach 50; 11.6 chips on average (a skill game).
 */
export const YACHT_TILT: Tilt = { center: 8, left: 8, right: 1.8, bust: 16 };

/**
 * The next roll with the 승리 추세: rolled again unless kept, `keep(multiplier)` being the chance for the hand the
 * dice show. The middle roll is judged as if it were the last, so the held dice rarely leave no way out.
 */
export function rollTilted(s: RoundState, keep: (mult: number) => number, int: (n: number) => number = randomInt): RoundState {
  return tiltedDraw(() => roll(s, int), (next) => keep(evaluate(next.dice).mult), int);
}

/**
 * How the round ends if the player stops answering now (reload, window closed): the dice chosen so far stay,
 * the rest is rolled out. When every die is chosen, only the locked ones stay (one die must roll).
 */
export function autoFinish(s: RoundState, int: (n: number) => number = randomInt): Die[] {
  let cur: RoundState = keeps(s).every((k) => k) ? { ...s, held: s.locked.slice() } : s;
  while (cur.rolls < ROLLS) cur = roll(cur, int);
  return cur.dice;
}
