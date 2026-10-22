import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CONFIG, loadSettings, normalizeSettings, saveSettings, sessionEconomy } from '../../src/config';
import { drawWin, maxBetFor, quit, resumePhase, sessionNet, settleRound as settle, startSession, winAmount, winText, type Session } from '../../src/game/session';
import type { Rng } from '../../src/rng';
import type { Plan, Slot } from '../../src/game/shuffle';
import { STATE_KEY, emptyStats, loadState, recordPayout, recordRound, saveState } from '../../src/storage';

const ECON = CONFIG.economy;
const plan: Plan = { level: 'hardest', start: 0, moves: [], final: 0, ceiling: 1, totalMs: 0 };
const WIN: Slot = 0, LOSE: Slot = 1;
/** Rounds every fractional win down (float() near 1) or up (float() = 0). */
const DOWN: Rng = { int: () => 0, float: () => 0.999999, coin: () => false };
const UP: Rng = { int: () => 0, float: () => 0, coin: () => false };
const settleRound = (s: Session, level: Parameters<typeof settle>[1], bet: number, pick: Slot, p: Plan, rng: Rng = DOWN) => settle(s, level, bet, pick, p, rng);

describe('session', () => {
  it('starts with 5 chips and no rounds', () => {
    const s = startSession(ECON, 1000);
    expect(s.stack).toBe(5);
    expect(s.rounds).toEqual([]);
    expect(s.ended).toBeNull();
    expect(sessionNet(s)).toBe(0);
  });

  it('a hit wins bet × multiplier on average, rounded by chance: 중간 ×1, 높음 ×1.5, 최상 ×1.73', () => {
    expect([1, 2, 3, 4, 5, 10].map((b) => winAmount(b, 'normal'))).toEqual([1, 2, 3, 4, 5, 10]);
    expect([1, 2, 3, 4, 5, 10].map((b) => winAmount(b, 'high'))).toEqual([2, 3, 5, 6, 8, 15]); // the most a hit can win
    expect([1, 2, 3, 4, 5, 10].map((b) => winAmount(b, 'hardest'))).toEqual([2, 4, 6, 7, 9, 18]);
    expect([1, 2, 5].map((b) => drawWin(b, 'high', DOWN))).toEqual([1, 3, 7]);
    expect([1, 2, 5].map((b) => drawWin(b, 'high', UP))).toEqual([2, 3, 8]);
    expect(drawWin(4, 'normal', UP)).toBe(4);
    expect(winText(5, 'high')).toBe('+7~8');
    expect(winText(2, 'high')).toBe('+3');
    // The chance of the extra chip is the fraction: 1 × 1.73 → 2 with probability 0.73.
    const at = (f: number): Rng => ({ int: () => 0, float: () => f, coin: () => false });
    expect(drawWin(1, 'hardest', at(0.72))).toBe(2);
    expect(drawWin(1, 'hardest', at(0.74))).toBe(1);
  });

  it('odds payout: a win adds bet × multiplier, a loss takes only the bet', () => {
    const s = startSession(ECON, 0);
    const w = settleRound(s, 'hardest', 5, WIN, plan);
    expect(w.stack).toBe(13); // 5 × 1.73 = 8.65 → 8 (rounded down here)
    expect(w.rounds).toEqual([{ level: 'hardest', bet: 5, pick: 0, ball: 0, win: true, delta: 8 }]);
    const l = settleRound(s, 'hardest', 2, LOSE, plan);
    expect(l.stack).toBe(3);
    expect(l.rounds[0].delta).toBe(-2);
    expect(l.ended).toBeNull();
    expect(s.rounds).toEqual([]); // pure
  });

  it('maxBetFor: the whole stack unless a hit would pay out more than 50 chips; free levels take none', () => {
    const s = startSession(ECON, 0); // 5 chips
    for (const level of ['normal', 'high', 'hardest'] as const) {
      expect(maxBetFor(s, level)).toBe(5);
      expect(maxBetFor({ ...s, stack: 1 }, level)).toBe(1);
    }
    expect(maxBetFor(s, 'easy')).toBe(0);
    expect(maxBetFor({ ...s, stack: 20 }, 'normal')).toBe(20); // 20 + 20 = 40
    expect(maxBetFor({ ...s, stack: 30 }, 'normal')).toBe(20); // 30 + 20 = 50
    expect(maxBetFor({ ...s, stack: 30 }, 'high')).toBe(13); // 30 + ceil(13 × 1.5) = 50
    expect(maxBetFor({ ...s, stack: 30 }, 'hardest')).toBe(11); // 30 + ceil(11 × 1.73) = 50; 12 → 51
    expect(maxBetFor({ ...s, stack: 49 }, 'hardest')).toBe(0); // a 1-chip hit could pay 2
    expect(maxBetFor({ ...s, stack: 49 }, 'normal')).toBe(1);
    for (let stack = 1; stack < ECON.autoSettleAt; stack++) {
      for (const level of ['normal', 'high', 'hardest'] as const) {
        const b = maxBetFor({ ...s, stack }, level);
        if (level === 'normal' || stack <= 48) expect(b).toBeGreaterThanOrEqual(1); // something can always be bet
        expect(stack + winAmount(b, level)).toBeLessThanOrEqual(ECON.autoSettleAt); // a hit stays within 50
        if (b < stack) expect(stack + winAmount(b + 1, level)).toBeGreaterThan(ECON.autoSettleAt); // the largest such bet
      }
    }
  });

  it(`never pays out more than ${ECON.autoSettleAt} chips and settles by itself on reaching it`, () => {
    const s = { ...startSession(ECON, 0), stack: 30 };
    expect(() => settleRound(s, 'normal', 21, WIN, plan)).toThrow(); // 30 + 21 would pass 50
    const at50 = settleRound(s, 'normal', 20, WIN, plan);
    expect(at50.stack).toBe(50);
    expect(at50.ended).toBe('cap');
    expect(() => settleRound(at50, 'normal', 1, WIN, plan)).toThrow();
    expect(quit(at50).ended).toBe('cap');
    expect(settleRound(s, 'hardest', 10, WIN, plan).stack).toBe(47); // 30 + 17 (17.3 rounded down): play on
    const below = settleRound(s, 'hardest', 9, WIN, plan, UP); // 30 + 16 (15.57 rounded up)
    expect(below.stack).toBe(46);
    expect(below.ended).toBeNull();
    // A session saved before autoSettleAt existed still uses the configured line.
    const old = { ...s, econ: { buyIn: 5 } } as unknown as Session;
    expect(maxBetFor(old, 'normal')).toBe(20);
    expect(settleRound(old, 'normal', 20, WIN, plan).ended).toBe('cap');
  });

  it('rejects bets that are not allowed and rounds after the end', () => {
    const s = startSession(ECON, 0);
    expect(() => settleRound(s, 'hardest', 6, WIN, plan)).toThrow();
    expect(() => settleRound(s, 'normal', 0, WIN, plan)).toThrow();
    expect(() => settleRound(s, 'normal', 1.5, WIN, plan)).toThrow();
    expect(() => settleRound(s, 'easy', 1, WIN, plan)).toThrow();
    expect(() => settleRound(quit(s), 'normal', 1, WIN, plan)).toThrow();
  });

  it('every bet sequence keeps chips within 0..50, ends as broke exactly at 0 and as cap exactly at 50', () => {
    const walk = (s: Session, depth: number): void => {
      if (depth === 0) return;
      for (const level of ['normal', 'high', 'hardest'] as const) {
        for (let bet = 1; bet <= maxBetFor(s, level); bet++) {
          for (const pick of [WIN, LOSE]) {
            const n = settleRound(s, level, bet, pick, plan, bet % 2 ? UP : DOWN);
            expect(n.stack).toBeGreaterThanOrEqual(0);
            expect(n.stack).toBeLessThanOrEqual(ECON.autoSettleAt);
            expect(n.stack - s.stack).toBe(pick === WIN ? drawWin(bet, level, bet % 2 ? UP : DOWN) : -bet);
            expect(n.ended).toBe(n.stack === 0 ? 'broke' : n.stack === ECON.autoSettleAt ? 'cap' : null);
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
    let s = startSession(ECON, 123);
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
    const won = quit(settleRound(startSession(ECON, 1), 'hardest', 5, WIN, plan)); // 5 + 8 (8.65 rounded down) = 13
    const capped = settleRound({ ...startSession(ECON, 2), stack: 30 }, 'normal', 20, WIN, plan); // 50 → 자동 정산
    const st = [s, won, capped].reduce(recordPayout, emptyStats());
    expect(st.sessions).toBe(3);
    expect(st.chipsIn).toBe(15);
    expect(st.chipsOut).toBe(0 + 13 + 50);
    expect(st.endReasons).toEqual({ broke: 1, quit: 1, cap: 1 });
    expect(st.nets).toEqual({ '-5': 1, '8': 1, '45': 1 });
    expect(() => recordPayout(st, startSession(ECON, 2))).toThrow();
  });

  it('settings merge over defaults; a maxBet saved by an older version is dropped', () => {
    expect(loadSettings()).toEqual({ pin: '0000', sound: { muted: false, volume: 0.7 } });
    expect(normalizeSettings({ maxBet: 3, pin: '', sound: { volume: 3 } })).toEqual({
      pin: '0000',
      sound: { muted: false, volume: 1 },
    });
    saveSettings({ pin: '1234', sound: { muted: true, volume: 0.2 } });
    expect(loadSettings()).toEqual({ pin: '1234', sound: { muted: true, volume: 0.2 } });
    expect(sessionEconomy(loadSettings())).toEqual({ buyIn: 5, autoSettleAt: 50 });
  });
});
