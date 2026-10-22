// 승리 추세 (플랫폼 sdk/casino.ts) for 야바위: the guest's pick cannot be drawn again, so the round is shuffled easier
// (like 쉬움) or harder (like 최상) instead, just often enough that an average guest's chance of a hit becomes what
// the 승리 추세 makes of it. A sharper guest still does better. Only the balance counts here, never the bet (with
// just a hit or a miss, judging by the bet would hand an all-in bet the easy shuffle): under the center a miss
// stands only with chance (chips / center)^left, over it a hit with chance (center / chips)^right.
import type { GameConfig, LevelId } from '../config';

/** The level to shuffle like for a round at `level` (it still pays as `level`); `chips`: the guest's chips in all. */
export function tiltedShuffle(level: LevelId, chips: number, cfg: GameConfig, float: () => number): LevelId {
  const t = cfg.tilt;
  const p = t.hit[level];
  const c = Math.max(1, chips);
  const hit = p * (c > t.center ? (t.center / c) ** t.right : 1);
  const want = hit / (hit + (1 - p) * (c < t.center ? (c / t.center) ** t.left : 1));
  if (want > p) return float() < (want - p) / (t.hit.easy - p) ? 'easy' : level;
  if (want < p && t.hit.hardest < p) return float() < (p - want) / (p - t.hit.hardest) ? 'hardest' : level;
  return level;
}
