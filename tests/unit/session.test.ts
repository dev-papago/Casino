import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CONFIG, loadSettings, normalizeSettings, saveSettings, sessionEconomy, type EconomyConfig } from '../../src/config';
import { endReason, quit, resumePhase, sessionNet, settleRound, startSession, type Session } from '../../src/game/session';
import type { Plan, Slot } from '../../src/game/shuffle';
import { STATE_KEY, emptyStats, loadState, recordPayout, recordRound, saveState } from '../../src/storage';

const ECON = CONFIG.economy;
const plan: Plan = { level: 'hardest', start: 0, moves: [], final: 0, ceiling: 1, totalMs: 0 };
const WIN: Slot = 0, LOSE: Slot = 1;
const econWith = (maxRounds: number): EconomyConfig => ({ ...ECON, maxRounds });

describe('session', () => {
  it('starts with buyIn - fee = 5 game chips', () => {
    const s = startSession(ECON, 1000);
    expect(s.stack).toBe(5);
    expect(s.rounds).toEqual([]);
    expect(s.ended).toBeNull();
    expect(sessionNet(s)).toBe(-1);
  });

  it('a win is +2 and a loss is -1', () => {
    const s = startSession(ECON, 0);
    const w = settleRound(s, WIN, plan);
    expect(w.stack - s.stack).toBe(2);
    expect(w.rounds).toEqual([{ pick: 0, ball: 0, win: true }]);
    const l = settleRound(s, LOSE, plan);
    expect(l.stack - s.stack).toBe(-1);
    expect(l.rounds).toEqual([{ pick: 1, ball: 0, win: false }]);
    expect(s.rounds).toEqual([]); // pure
  });

  it.each([4, 5, 6, 7, 8, 9, 10])('maxRounds %i: every win/loss order ends correctly inside settleRound', (maxRounds) => {
    const seen = { clear: 0, broke: 0, rounds: 0 };
    const walk = (s: Session): void => {
      for (const pick of [WIN, LOSE]) {
        const n = settleRound(s, pick, plan);
        const wins = n.rounds.filter((r) => r.win).length;
        expect(n.stack).toBe(5 - n.rounds.length + 3 * wins);
        expect(n.stack).toBeGreaterThanOrEqual(0);
        expect(n.stack).toBeLessThanOrEqual(17);
        expect(n.ended).toBe(endReason(n));
        if (sessionNet(n) >= ECON.winCap) expect(n.ended).toBe('clear');
        else if (n.stack === 0) expect(n.ended).toBe('broke');
        else if (n.rounds.length === maxRounds) expect(n.ended).toBe('rounds');
        else expect(n.ended).toBeNull();
        if (n.ended) {
          seen[n.ended as keyof typeof seen]++;
          expect(() => settleRound(n, WIN, plan)).toThrow();
        } else walk(n);
      }
    };
    walk(startSession(econWith(maxRounds), 0));
    if (maxRounds >= 5) expect(seen.broke).toBeGreaterThan(0); // 5 straight losses empty the stack
    expect(seen.rounds).toBeGreaterThan(0);
    if (maxRounds >= 6) expect(seen.clear).toBeGreaterThan(0); // 6 straight wins reach +11
  });

  it('quit ends with "quit"; an ended session keeps its reason', () => {
    const s = quit(settleRound(startSession(ECON, 0), WIN, plan));
    expect(s.ended).toBe('quit');
    expect(s.stack).toBe(7);
    let b = startSession(ECON, 0);
    while (!b.ended) b = settleRound(b, LOSE, plan);
    expect(b.ended).toBe('broke');
    expect(quit(b).ended).toBe('broke');
  });

  it('survives a JSON round trip', () => {
    let s = startSession(econWith(6), 123);
    s = settleRound(settleRound(s, WIN, plan), LOSE, plan);
    const back = JSON.parse(JSON.stringify(s)) as Session;
    expect(back).toEqual(s);
    expect(settleRound(back, WIN, plan)).toEqual(settleRound(s, WIN, plan));
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
    s = settleRound(s, WIN, plan);
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
    while (!s.ended) s = settleRound(s, LOSE, plan);
    const st = recordPayout(recordPayout(emptyStats(), s), quit(settleRound(startSession(ECON, 1), WIN, plan)));
    expect(st.sessions).toBe(2);
    expect(st.chipsIn).toBe(12);
    expect(st.chipsOut).toBe(0 + 7);
    expect(st.endReasons).toEqual({ clear: 0, broke: 1, rounds: 0, quit: 1 });
    expect(st.nets).toEqual({ '-6': 1, '1': 1 });
    expect(() => recordPayout(st, startSession(ECON, 2))).toThrow();
  });

  it('settings merge over defaults and clamp maxRounds to 4..10', () => {
    expect(loadSettings()).toEqual({ maxRounds: 8, pin: '0000', sound: { muted: false, volume: 0.7 } });
    expect(normalizeSettings({ maxRounds: 99 }).maxRounds).toBe(10);
    expect(normalizeSettings({ maxRounds: 1 }).maxRounds).toBe(4);
    expect(normalizeSettings({ maxRounds: 'x', pin: '', sound: { volume: 3 } })).toEqual({
      maxRounds: 8,
      pin: '0000',
      sound: { muted: false, volume: 1 },
    });
    saveSettings({ maxRounds: 6, pin: '1234', sound: { muted: true, volume: 0.2 } });
    expect(loadSettings()).toEqual({ maxRounds: 6, pin: '1234', sound: { muted: true, volume: 0.2 } });
    expect(sessionEconomy(loadSettings())).toEqual({ ...ECON, maxRounds: 6 });
  });
});
