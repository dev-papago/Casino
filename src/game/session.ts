// Paid (hardest) session rules, DESIGN.md section 3. Pure; every function returns a new Session.
import type { EconomyConfig } from '../config';
import type { Plan, Slot } from './shuffle';

export type EndReason = 'clear' | 'broke' | 'rounds' | 'quit';
export const END_REASONS: readonly EndReason[] = ['clear', 'broke', 'rounds', 'quit'];
export interface RoundRecord {
  pick: Slot;
  ball: Slot;
  win: boolean;
}
export interface Session {
  id: string;
  startedAt: number;
  econ: EconomyConfig; // snapshot at start, maxRounds taken from Settings
  stack: number; // game chips = chips to hand back right now
  rounds: RoundRecord[];
  ended: EndReason | null;
}

export function startSession(econ: EconomyConfig, now: number): Session {
  return {
    id: `s${now.toString(36)}`,
    startedAt: now,
    econ: { ...econ, maxRoundsRange: [...econ.maxRoundsRange] },
    stack: econ.buyIn - econ.fee,
    rounds: [],
    ended: null,
  };
}

/** Session net in chips: what the player gets back minus what they handed over (−buyIn … ). */
export function sessionNet(s: Session): number {
  return s.stack - s.econ.buyIn;
}

/** Checked after every round, in this order: clear, broke, rounds. */
export function endReason(s: Session): EndReason | null {
  const e = s.econ;
  if (sessionNet(s) >= e.winCap) return 'clear';
  if (s.stack < e.stake) return 'broke';
  if (s.rounds.length >= e.maxRounds) return 'rounds';
  return null;
}

/** One paid round: take the stake, pay returnOnWin on a hit, then decide whether the session ended. */
export function settleRound(s: Session, pick: Slot, plan: Plan): Session {
  if (s.ended) throw new Error(`session already ended (${s.ended})`);
  if (s.stack < s.econ.stake) throw new Error('not enough chips for a round');
  const ball = plan.final;
  const win = pick === ball;
  const next: Session = {
    ...s,
    stack: s.stack - s.econ.stake + (win ? s.econ.returnOnWin : 0),
    rounds: [...s.rounds, { pick, ball, win }],
  };
  return { ...next, ended: endReason(next) };
}

/** The player stops between rounds. An already-ended session keeps its reason. */
export function quit(s: Session): Session {
  return s.ended ? s : { ...s, ended: 'quit' };
}

/** Screen to show after a reload: no session → idle; ended → settlement; otherwise the next round. */
export function resumePhase(s: Session | null): 'idle' | 'settlement' | 'ready' {
  if (!s) return 'idle';
  return s.ended ? 'settlement' : 'ready';
}
