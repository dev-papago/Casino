import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CONFIG, loadSettings, normalizeSettings, saveSettings, sessionEconomy, type EconomyConfig } from '../../src/config';
import { betAmount, maxBetFor, quit, resumePhase, sessionNet, settleRound, startSession, type Session } from '../../src/game/session';
import type { Plan, Slot } from '../../src/game/shuffle';
import { STATE_KEY, emptyStats, loadState, recordPayout, recordRound, saveState } from '../../src/storage';

const ECON = CONFIG.economy;
const plan: Plan = { level: 'hardest', start: 0, moves: [], final: 0, ceiling: 1, totalMs: 0 };
const WIN: Slot = 0, LOSE: Slot = 1;
const econWith = (maxBet: number): EconomyConfig => ({ ...ECON, maxBet });

describe('session', () => {
  it('starts with 5 chips and no rounds', () => {
    const s = startSession(ECON, 1000);
    expect(s.stack).toBe(5);
    expect(s.rounds).toEqual([]);
    expect(s.ended).toBeNull();
    expect(sessionNet(s)).toBe(0);
  });

  it('bet amounts are floor(bet × multiplier): 중간 ×1.2, 높음 ×1.5, 최상 ×2', () => {
    expect([1, 2, 3, 4, 5].map((b) => betAmount(b, 'normal'))).toEqual([1, 2, 3, 4, 6]);
    expect([1, 2, 3, 4, 5].map((b) => betAmount(b, 'high'))).toEqual([1, 3, 4, 6, 7]);
    expect([1, 2, 3, 4, 5].map((b) => betAmount(b, 'hardest'))).toEqual([2, 4, 6, 8, 10]);
  });

  it('a win adds and a loss takes the same amount', () => {
    const s = startSession(ECON, 0);
    const w = settleRound(s, 'hardest', 2, WIN, plan);
    expect(w.stack).toBe(9);
    expect(w.rounds).toEqual([{ level: 'hardest', bet: 2, pick: 0, ball: 0, win: true, delta: 4 }]);
    const l = settleRound(s, 'hardest', 2, LOSE, plan);
    expect(l.stack).toBe(1);
    expect(l.rounds[0].delta).toBe(-4);
    expect(l.ended).toBeNull();
    expect(s.rounds).toEqual([]); // pure
  });

  it('maxBetFor: capped by maxBet and by what the stack can lose; free levels take no bets', () => {
    const s = startSession(ECON, 0); // 5 chips, maxBet 5
    expect(maxBetFor(s, 'normal')).toBe(4); // 5 × 1.2 = 6 > 5
    expect(maxBetFor(s, 'high')).toBe(3); // 4 × 1.5 = 6 > 5
    expect(maxBetFor(s, 'hardest')).toBe(2);
    expect(maxBetFor(s, 'easy')).toBe(0);
    const rich = { ...startSession(econWith(5), 0), stack: 100 };
    expect(maxBetFor(rich, 'hardest')).toBe(5);
    const one = { ...s, stack: 1 };
    expect(maxBetFor(one, 'normal')).toBe(1);
    expect(maxBetFor(one, 'high')).toBe(1);
    expect(maxBetFor(one, 'hardest')).toBe(0);
  });

  it('rejects bets that are not allowed and rounds after the end', () => {
    const s = startSession(ECON, 0);
    expect(() => settleRound(s, 'hardest', 3, WIN, plan)).toThrow();
    expect(() => settleRound(s, 'normal', 0, WIN, plan)).toThrow();
    expect(() => settleRound(s, 'normal', 1.5, WIN, plan)).toThrow();
    expect(() => settleRound(s, 'easy', 1, WIN, plan)).toThrow();
    expect(() => settleRound(quit(s), 'normal', 1, WIN, plan)).toThrow();
  });

  it('every bet sequence keeps chips >= 0 and ends as broke exactly at 0', () => {
    const walk = (s: Session, depth: number): void => {
      if (depth === 0) return;
      for (const level of ['normal', 'high', 'hardest'] as const) {
        for (let bet = 1; bet <= maxBetFor(s, level); bet++) {
          for (const pick of [WIN, LOSE]) {
            const n = settleRound(s, level, bet, pick, plan);
            expect(n.stack).toBeGreaterThanOrEqual(0);
            expect(n.stack - s.stack).toBe((pick === WIN ? 1 : -1) * betAmount(bet, level));
            expect(n.ended).toBe(n.stack === 0 ? 'broke' : null);
            if (!n.ended) walk(n, depth - 1);
          }
        }
      }
    };
    walk(startSession(ECON, 0), 3);
  });

  it('quit ends with "quit"; an ended session keeps its reason', () => {
    const s = quit(settleRound(startSession(ECON, 0), 'normal', 4, WIN, plan));
    expect(s.ended).toBe('quit');
    expect(s.stack).toBe(9);
    const b = settleRound(startSession(ECON, 0), 'normal', 4, LOSE, plan); // 5 − 4 = 1
    const z = settleRound(b, 'normal', 1, LOSE, plan);
    expect(z.ended).toBe('broke');
    expect(quit(z).ended).toBe('broke');
  });

  it('survives a JSON round trip', () => {
    let s = startSession(econWith(3), 123);
    s = settleRound(settleRound(s, 'high', 2, WIN, plan), 'hardest', 1, LOSE, plan);
    const back = JSON.parse(JSON.stringify(s)) as Session;
    expect(back).toEqual(s);
    expect(settleRound(back, 'normal', 1, WIN, plan)).toEqual(settleRound(s, 'normal', 1, WIN, plan));
  });

  it('resumePhase: idle / ready / settlement', () => {
    const s = startSession(ECON, 0);
    expect(resumePhase(null)).toBe('idle');
    expect(resumePhase(s)).toBe('ready');
    expect(resumePhase(quit(s))).toBe('settlement');
  });
});

describe('persistence', () => {
  const store = new Map<string, string>();
  beforeEach(() => {
    store.clear();
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    };
  });
  afterEach(() => {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  });

  it('state round-trips through localStorage in one key', () => {
    let s = startSession(ECON, 5);
    s = settleRound(s, 'hardest', 1, WIN, plan);
    const stats = recordRound(recordRound(emptyStats(), 'hardest', true), 'easy', false);
    expect(saveState({ session: s, stats })).toBe(true);
    expect([...store.keys()]).toEqual([STATE_KEY]);
    expect(loadState()).toEqual({ session: s, stats });
  });

  it('missing or corrupt data falls back to defaults', () => {
    expect(loadState()).toEqual({ session: null, stats: emptyStats() });
    store.set(STATE_KEY, '{not json');
    expect(loadState()).toEqual({ session: null, stats: emptyStats() });
    store.set(STATE_KEY, JSON.stringify({ session: { id: 1 }, stats: { sessions: 3 } }));
    const st = loadState();
    expect(st.session).toBeNull();
    expect(st.stats.sessions).toBe(3);
    expect(st.stats.levels.hardest).toEqual({ rounds: 0, hits: 0 });
    delete (globalThis as { localStorage?: unknown }).localStorage;
    expect(loadState().session).toBeNull();
    expect(saveState({ session: null, stats: emptyStats() })).toBe(false);
  });

  it('recordPayout counts chips, reasons and the net histogram', () => {
    let s = startSession(ECON, 0);
    while (!s.ended) s = settleRound(s, 'normal', 1, LOSE, plan);
    const st = recordPayout(recordPayout(emptyStats(), s), quit(settleRound(startSession(ECON, 1), 'hardest', 2, WIN, plan)));
    expect(st.sessions).toBe(2);
    expect(st.chipsIn).toBe(10);
    expect(st.chipsOut).toBe(0 + 9);
    expect(st.endReasons).toEqual({ broke: 1, quit: 1 });
    expect(st.nets).toEqual({ '-5': 1, '4': 1 });
    expect(() => recordPayout(st, startSession(ECON, 2))).toThrow();
  });

  it('settings merge over defaults and clamp maxBet to 1..20', () => {
    expect(loadSettings()).toEqual({ maxBet: 5, pin: '0000', sound: { muted: false, volume: 0.7 } });
    expect(normalizeSettings({ maxBet: 99 }).maxBet).toBe(20);
    expect(normalizeSettings({ maxBet: 0 }).maxBet).toBe(1);
    expect(normalizeSettings({ maxBet: 'x', pin: '', sound: { volume: 3 } })).toEqual({
      maxBet: 5,
      pin: '0000',
      sound: { muted: false, volume: 1 },
    });
    saveSettings({ maxBet: 3, pin: '1234', sound: { muted: true, volume: 0.2 } });
    expect(loadSettings()).toEqual({ maxBet: 3, pin: '1234', sound: { muted: true, volume: 0.2 } });
    expect(sessionEconomy(loadSettings())).toEqual({ ...ECON, maxBet: 3 });
  });
});
