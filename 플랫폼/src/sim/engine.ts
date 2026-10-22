// 확률 시뮬레이터: many guests play one game with a chip-betting habit, and the result is how often a guest ends
// with 0, 1, …, 50 chips. Every game runs its own code: the plinko boards, the slot reels, the yacht rules (with an
// average player's holds), the 야바위 payouts (hit rates per player type) and the 영끌문S market (with an average
// trader). Pure: the caller hands in the randomness, so tests can seed it and the page runs it in a worker.
import { BOARDS, BOARD_IDS, PLINKO_TILT, drawSlotTilted, type BoardId } from '../../games/plinko/src/table.ts';
import { SLOT_TILT, evaluate as slotEvaluate, lineAt, spinTilted } from '../../games/slot/src/table.ts';
import { YACHT_TILT, evaluate as yachtEvaluate } from '../../games/yacht/src/rules.ts';
import yabawiConfig from '../../games/yabawi/src/config/defaults.json';
import { tiltedShuffle } from '../../games/yabawi/src/game/tilt.ts';
import { CONFIG as YK } from '../../games/yeongkkeul/src/config.ts';
import { Market } from '../../games/yeongkkeul/src/game/market.ts';
import { accrueFunding, addDividend, dividendRate, buy, equity, fundingPerSec, isBroke, liquidate, maxMargin, newAccount, sell, type Account } from '../../games/yeongkkeul/src/game/account.ts';
import { keepChance, type Tilt } from '../../sdk/casino.ts';
import { averageYachtRound } from './yacht-player.ts';

export type SimGame = 'plinko' | 'slot' | 'yacht' | 'yabawi' | 'yeongkkeul';

/** Uniform randomness: int(n) in [0, n), float() in [0, 1). */
export interface SimRng {
  int(n: number): number;
  float(): number;
}

export type YabawiLevel = 'normal' | 'high' | 'hardest';
export type YabawiPlayer = 'average' | 'sharp' | 'expert';
export type TraderLeverage = 'low' | 'mixed' | 'max';

export interface SimParams {
  game: SimGame;
  plinkoBoard: BoardId | 'random';
  yabawiLevel: YabawiLevel | 'random';
  yabawiPlayer: YabawiPlayer;
  leverage: TraderLeverage; // 영끌문S: how the trader picks leverage once it is open
  start: number; // chips a guest starts with
  bet: { kind: 'fixed'; chips: number } | { kind: 'share'; lo: number; hi: number }; // share: of the balance, 0..1
  minutes: number; // how long a guest plays
  perMin: number; // rounds a minute (영끌문S ignores it: one session for the whole time)
  goal: number; // a guest stops on reaching this many chips (0: plays on)
  guests: number;
  luck: boolean; // the 승리 추세 (sdk/casino.ts): results pulled toward each game's center
}

/** The pace a guest keeps, roughly, per game (rounds a minute). */
export const PACE: Record<SimGame, number> = { plinko: 20, slot: 12, yacht: 2.4, yabawi: 6, yeongkkeul: 0 };

/** Defaults: the festival guest (5 free chips, bets half to all of the balance, 17 minutes, stops at 50). */
export const DEFAULTS: SimParams = {
  game: 'plinko',
  plinkoBoard: 'random',
  yabawiLevel: 'random',
  yabawiPlayer: 'average',
  leverage: 'mixed',
  start: 5,
  bet: { kind: 'share', lo: 0.5, hi: 1 },
  minutes: 17,
  perMin: PACE.plinko,
  goal: 50,
  guests: 20000,
  luck: true,
};

/** Highest bucket: a guest with this many chips or more counts here (the physical-chip limit). */
export const TOP = 50;

/**
 * 야바위 hit rates by level for a type of guest, from the exact analysis of the shuffles in
 * games/yabawi/src/config/defaults.json (redo them when the shuffles change): average = the mean of a casual and a
 * skilled tracker; sharp = perfect eyes; expert = perfect eyes that also reason about overlaps.
 */
export const YABAWI_HIT: Record<YabawiPlayer, Record<YabawiLevel, number>> = {
  average: { normal: 0.4549, high: 0.364, hardest: 0.3335 },
  sharp: { normal: 0.475, high: 0.3836, hardest: 0.334 },
  expert: { normal: 0.508, high: 0.406, hardest: 0.3417 },
};
/** Hit rates on the 쉬움 shuffle (승리 추세: a round shuffled like 쉬움), same models. */
export const YABAWI_EASY_HIT: Record<YabawiPlayer, number> = { average: 0.9294, sharp: 0.96, expert: 0.97 };
export const YABAWI_PLAYER_LABEL: Record<YabawiPlayer, string> = { average: '보통 손님', sharp: '눈 좋은 손님', expert: '추론하는 고수' };
const YABAWI_LEVELS: YabawiLevel[] = ['normal', 'high', 'hardest'];

export interface SimResult {
  counts: number[]; // counts[k]: guests ending with k chips (k = TOP: TOP or more)
  guests: number;
  mean: number; // chips a guest ends with, on average (above TOP counted as TOP: what can be settled)
  rounds: number; // rounds played in all
  wagered: number; // chips staked in all
  returned: number; // chips paid back in all (stakes included)
}

/** Stochastic rounding: v chips → floor(v), plus one with probability frac(v). */
const roundChips = (v: number, rng: SimRng): number => {
  const w = Math.floor(v + 1e-9);
  return w + (rng.float() < v - w ? 1 : 0);
};

/** One round of a one-round game: what `stake` brings back to a guest with `bal` chips (stake included). */
function oneRound(p: SimParams, stake: number, bal: number, rng: SimRng): number {
  const int = (n: number) => rng.int(n);
  const keep = (t: Tilt) => (mult: number) => (p.luck ? keepChance(bal, bal - stake + stake * mult, t) : 1);
  switch (p.game) {
    case 'plinko': {
      const id = p.plinkoBoard === 'random' ? BOARD_IDS[rng.int(BOARD_IDS.length)] : p.plinkoBoard;
      const b = BOARDS[id];
      return stake * b.mults[drawSlotTilted(b, keep(PLINKO_TILT), int)];
    }
    case 'slot':
      return stake * slotEvaluate(lineAt(spinTilted(keep(SLOT_TILT), int))).mult;
    case 'yacht':
      return stake * yachtEvaluate(averageYachtRound(int, keep(YACHT_TILT))).mult;
    case 'yabawi': {
      const level = p.yabawiLevel === 'random' ? YABAWI_LEVELS[rng.int(3)] : p.yabawiLevel;
      const mult = yabawiConfig.levels[level].multiplier;
      const like = p.luck ? tiltedShuffle(level, bal, yabawiConfig, () => rng.float()) : level;
      const hit = like === 'easy' ? YABAWI_EASY_HIT[p.yabawiPlayer] : YABAWI_HIT[p.yabawiPlayer][like === 'hardest' ? 'hardest' : level];
      if (rng.float() >= hit) return 0;
      return stake + roundChips(stake * mult, rng); // odds: the bet back plus the win
    }
    default:
      throw new Error(`not a one-round game: ${p.game}`);
  }
}

function stakeFor(p: SimParams, balance: number, rng: SimRng): number {
  const want = p.bet.kind === 'fixed' ? p.bet.chips : Math.round(balance * (p.bet.lo + (p.bet.hi - p.bet.lo) * rng.float()));
  return Math.max(1, Math.min(balance, want));
}

/** One guest of a one-round game; returns the chips they end with and adds to the totals. */
function guestRounds(p: SimParams, rng: SimRng, t: { rounds: number; wagered: number; returned: number }): number {
  let bal = p.start;
  const n = Math.max(1, Math.round(p.minutes * p.perMin));
  for (let i = 0; i < n && bal > 0 && !(p.goal > 0 && bal >= p.goal); i++) {
    const stake = stakeFor(p, bal, rng);
    const back = oneRound(p, stake, bal, rng);
    bal += back - stake;
    t.rounds++;
    t.wagered += stake;
    t.returned += back;
  }
  return bal;
}

// ---------------------------------------------------------------- 영끌문S: an average trader

const TICK_S = YK.timing.tickMs / 1000;
/** Leverage and its weight, by the trader's habit (leverage opens at twice the deposit). */
const LEVERAGE_PICK: Record<TraderLeverage, [number, number][]> = {
  low: [[1, 1]],
  mixed: [
    [1, 0.4],
    [2, 0.25],
    [5, 0.2],
    [10, 0.15],
  ],
  max: [
    [10, 0.6],
    [5, 0.25],
    [2, 0.1],
    [1, 0.05],
  ],
};
export const LEVERAGE_LABEL: Record<TraderLeverage, string> = { low: '1×만', mixed: '골고루 (1× 위주)', max: '영끌 (10× 위주)' };

/**
 * One 영끌문S session: the whole balance goes in (chips × $1,000). The trader picks a random stock and
 * side (인버스 30%), a leverage when it is open (p.leverage), puts `bet` of the cash in, holds 20–90 s,
 * sells, waits 3–15 s, and goes again; 유지비 and liquidation apply. It stops at the goal or when time is up,
 * and the dollars come back as chips ($1,000 a chip, the fraction by chance).
 */
function guestTrader(p: SimParams, rng: SimRng, t: { rounds: number; wagered: number; returned: number }): number {
  const r = { int: (n: number) => rng.int(n), float: () => rng.float(), coin: () => rng.float() < 0.5 };
  const deposit = p.start * YK.economy.chipValue;
  const econ = { ...YK.economy, deposit, leverageFrom: 2 * deposit };
  const market = new Market(r);
  let acc: Account = newAccount(econ);
  const ticks = Math.round((p.minutes * 60) / TICK_S);
  const funding = new Map<string, number>();
  const rate = (id: string, lev: number, inv: boolean): number => {
    const key = `${id}:${lev}:${inv}`;
    let v = funding.get(key);
    if (v === undefined) funding.set(key, (v = fundingPerSec(market.get(id).def.events, lev, inv, econ)));
    return v;
  };
  let holding: { id: string; until: number } | null = null;
  let nextAt = Math.round(5 / TICK_S);
  const goalDollars = p.goal > 0 ? p.goal * YK.economy.chipValue : Infinity;
  const sellAll = (): void => {
    for (const id of Object.keys(acc.positions)) {
      const res = sell(acc, id, market.get(id).price, 1, econ);
      if (res.ok) acc = res.account;
    }
    holding = null;
  };
  for (let k = 0; k < ticks; k++) {
    market.step();
    const prices = market.prices();
    acc = accrueFunding(acc, (id, pos) => rate(id, pos.leverage, pos.inverse), TICK_S);
    const liq = liquidate(acc, prices, econ);
    if (liq.fills.length) {
      acc = liq.account;
      holding = null;
      nextAt = k + Math.round((3 + 12 * rng.float()) / TICK_S);
    }
    const eq0 = equity(acc, prices);
    acc = addDividend(acc, p.luck ? dividendRate(eq0 / YK.economy.chipValue, econ) : 0, TICK_S);
    const eq = equity(acc, prices);
    if (eq >= goalDollars) break;
    if (holding && k >= holding.until) {
      sellAll();
      nextAt = k + Math.round((3 + 12 * rng.float()) / TICK_S);
    }
    if (!holding && k >= nextAt) {
      if (isBroke(acc, econ)) break;
      const st = market.stocks[rng.int(market.stocks.length)];
      const inverse = rng.float() < 0.3;
      let lev = 1;
      if (eq >= econ.leverageFrom) {
        let u = rng.float();
        for (const [l, w] of LEVERAGE_PICK[p.leverage]) if ((u -= w) < 0) {
          lev = l;
          break;
        }
      }
      const share = p.bet.kind === 'fixed' ? Math.min(1, (p.bet.chips * YK.economy.chipValue) / Math.max(1, acc.cash)) : p.bet.lo + (p.bet.hi - p.bet.lo) * rng.float();
      const margin = Math.floor(maxMargin(acc.cash, lev, econ) * share * 100) / 100;
      const res = buy(acc, { stockId: st.def.id, price: st.price, margin, leverage: lev, inverse }, econ, eq);
      if (res.ok) {
        acc = res.account;
        holding = { id: st.def.id, until: k + Math.round((20 + 70 * rng.float()) / TICK_S) };
        t.rounds++;
      } else nextAt = k + Math.round(5 / TICK_S);
    }
  }
  sellAll();
  t.wagered += p.start;
  const chips = roundChips(Math.max(0, acc.cash) / YK.economy.chipValue, rng);
  t.returned += chips;
  return chips;
}

/** Runs `p.guests` guests; `progress(done)` is called now and then. */
export function simulate(p: SimParams, rng: SimRng, progress?: (done: number) => void): SimResult {
  const counts = new Array<number>(TOP + 1).fill(0);
  const t = { rounds: 0, wagered: 0, returned: 0 };
  let sum = 0;
  const every = p.game === 'yeongkkeul' ? 10 : 1000;
  for (let g = 0; g < p.guests; g++) {
    const end = p.game === 'yeongkkeul' ? guestTrader(p, rng, t) : guestRounds(p, rng, t);
    const k = Math.min(TOP, Math.max(0, end));
    counts[k]++;
    sum += k;
    if (progress && (g + 1) % every === 0) progress(g + 1);
  }
  return { counts, guests: p.guests, mean: sum / p.guests, ...t };
}

/** A fast seeded generator (sfc32) for the simulator; not for real games. */
export function fastRng(seed: number): SimRng {
  let a = 0x9e3779b9 ^ seed, b = 0x243f6a88 ^ (seed * 31), c = 0xb7e15162 ^ (seed * 17), d = 1;
  const next = (): number => {
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return t >>> 0;
  };
  for (let i = 0; i < 12; i++) next();
  return {
    float: () => next() / 0x1_0000_0000,
    int: (n) => Math.floor((next() / 0x1_0000_0000) * n),
  };
}

