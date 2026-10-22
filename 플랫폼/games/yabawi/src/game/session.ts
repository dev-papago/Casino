// Paid session rules. Pure; every function returns a new Session.
// Each round the player picks a level and a bet B. The multiplier is real odds: a hit wins B × multiplier
// chips on top of the bet, a miss loses the bet. Chips are whole, so a fractional win is rounded by chance
// (B × 1.5 = 7.5 → 8 half the time, 7 the other half): on average a hit pays exactly B × multiplier at every
// bet. The payout never goes above economy.autoSettleAt (50 chips): B can be the whole stack as long as the
// largest possible hit would not pass that line.
// Play goes on until 정산 (quit), until no chips are left (broke), or until the stack reaches the line
// (cap: 자동 정산).
import { CONFIG, type EconomyConfig, type LevelId } from '../config';
import type { Rng } from '../rng';
import type { Plan, Slot } from './shuffle';

export type EndReason = 'broke' | 'quit' | 'cap';
export const END_REASONS: readonly EndReason[] = ['broke', 'quit', 'cap'];
export interface RoundRecord {
  level: LevelId;
  bet: number;
  pick: Slot;
  ball: Slot;
  win: boolean;
  delta: number; // chips won (+) or lost (−) this round
}
export interface Session {
  id: string;
  startedAt: number;
  econ: EconomyConfig; // snapshot at start
  stack: number; // chips to hand back right now
  rounds: RoundRecord[];
  ended: EndReason | null;
}

export const multiplier = (level: LevelId): number => CONFIG.levels[level].multiplier;

/** Chips a hit wins on top of the bet, on average: bet × multiplier (may be fractional). A miss loses the bet. */
export const winValue = (bet: number, level: LevelId): number => bet * multiplier(level);

/** The most a hit can win: bet × multiplier rounded up. */
export const winAmount = (bet: number, level: LevelId): number => Math.ceil(winValue(bet, level) - 1e-9);

/** What a hit actually wins: the whole part, plus one more chip with probability equal to the fraction. */
export function drawWin(bet: number, level: LevelId, rng: Rng): number {
  const v = winValue(bet, level);
  const whole = Math.floor(v + 1e-9);
  const frac = v - whole;
  return whole + (frac > 1e-9 && rng.float() < frac ? 1 : 0);
}

/** "+7" or "+7~8" for the bet line. */
export function winText(bet: number, level: LevelId): string {
  const lo = Math.floor(winValue(bet, level) + 1e-9);
  const hi = winAmount(bet, level);
  return lo === hi ? `+${lo}` : `+${lo}~${hi}`;
}

/** The most a session can pay out; reaching it settles the session (an older saved session uses the config). */
export const autoSettleAt = (s: Session): number => s.econ.autoSettleAt ?? CONFIG.economy.autoSettleAt;

/**
 * Largest bet on `level` (0 on a free one): at most the stack (a miss loses only the bet), and small enough
 * that a hit does not take the stack past autoSettleAt. No other limit.
 */
export function maxBetFor(s: Session, level: LevelId): number {
  if (!CONFIG.levels[level].paid) return 0;
  const room = autoSettleAt(s) - s.stack; // chips a hit may still add
  let b = Math.max(0, Math.min(s.stack, Math.ceil((room + 1) / multiplier(level)) - 1));
  while (b > 0 && winAmount(b, level) > room) b--;
  while (b < s.stack && winAmount(b + 1, level) <= room) b++;
  return b;
}

/** True when the bet is capped by the payout line rather than by the stack. */
export const cappedByPayout = (s: Session, level: LevelId): boolean => maxBetFor(s, level) < s.stack;

export function startSession(econ: EconomyConfig, now: number): Session {
  return {
    id: `s${now.toString(36)}`,
    startedAt: now,
    econ: { ...econ },
    stack: econ.buyIn,
    rounds: [],
    ended: null,
  };
}

/** Session net in chips: what the player gets back minus the chips they started with. */
export function sessionNet(s: Session): number {
  return s.stack - s.econ.buyIn;
}

/** One paid round on `level` with `bet`; the session ends by itself at 0 chips or at autoSettleAt. */
export function settleRound(s: Session, level: LevelId, bet: number, pick: Slot, plan: Plan, rng: Rng): Session {
  if (s.ended) throw new Error(`session already ended (${s.ended})`);
  if (!Number.isInteger(bet) || bet < 1 || bet > maxBetFor(s, level)) throw new Error(`bet ${bet} not allowed on ${level}`);
  const ball = plan.final;
  const win = pick === ball;
  const delta = win ? drawWin(bet, level, rng) : -bet;
  const stack = s.stack + delta;
  const ended = stack <= 0 ? 'broke' : stack >= autoSettleAt(s) ? 'cap' : null;
  return { ...s, stack, rounds: [...s.rounds, { level, bet, pick, ball, win, delta }], ended };
}

/** 정산: the player stops between rounds. An already-ended session keeps its reason. */
export function quit(s: Session): Session {
  return s.ended ? s : { ...s, ended: 'quit' };
}

/** Screen to show after a reload: no session → idle; ended → settlement; otherwise the next round. */
export function resumePhase(s: Session | null): 'idle' | 'settlement' | 'ready' {
  if (!s) return 'idle';
  return s.ended ? 'settlement' : 'ready';
}
