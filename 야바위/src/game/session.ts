// Paid session rules (DESIGN.md section 3). Pure; every function returns a new Session.
// Each round the player picks a level and a bet B. A hit wins floor(B × multiplier) chips,
// a miss loses the same amount. Play goes on until 정산 (quit) or until no chips are left.
import { CONFIG, type EconomyConfig, type LevelId } from '../config';
import type { Plan, Slot } from './shuffle';

export type EndReason = 'broke' | 'quit';
export const END_REASONS: readonly EndReason[] = ['broke', 'quit'];
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
  econ: EconomyConfig; // snapshot at start, maxBet taken from Settings
  stack: number; // chips to hand back right now
  rounds: RoundRecord[];
  ended: EndReason | null;
}

export const multiplier = (level: LevelId): number => CONFIG.levels[level].multiplier;

/** Chips won or lost on a bet: floor(bet × multiplier), whole chips only. */
export function betAmount(bet: number, level: LevelId): number {
  return Math.floor(bet * multiplier(level) + 1e-9);
}

/** Largest bet on `level` whose loss the stack can cover, capped by econ.maxBet (0 = cannot play it). */
export function maxBetFor(s: Session, level: LevelId): number {
  if (!CONFIG.levels[level].paid) return 0;
  let b = 0;
  while (b < s.econ.maxBet && betAmount(b + 1, level) <= s.stack) b++;
  return b;
}

export function startSession(econ: EconomyConfig, now: number): Session {
  return {
    id: `s${now.toString(36)}`,
    startedAt: now,
    econ: { ...econ, maxBetRange: [...econ.maxBetRange] },
    stack: econ.buyIn,
    rounds: [],
    ended: null,
  };
}

/** Session net in chips: what the player gets back minus the chips they started with. */
export function sessionNet(s: Session): number {
  return s.stack - s.econ.buyIn;
}

/** One paid round on `level` with `bet`; the session ends by itself only when no chips are left. */
export function settleRound(s: Session, level: LevelId, bet: number, pick: Slot, plan: Plan): Session {
  if (s.ended) throw new Error(`session already ended (${s.ended})`);
  if (!Number.isInteger(bet) || bet < 1 || bet > maxBetFor(s, level)) throw new Error(`bet ${bet} not allowed on ${level}`);
  const ball = plan.final;
  const win = pick === ball;
  const delta = (win ? 1 : -1) * betAmount(bet, level);
  const stack = s.stack + delta;
  return { ...s, stack, rounds: [...s.rounds, { level, bet, pick, ball, win, delta }], ended: stack <= 0 ? 'broke' : null };
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
