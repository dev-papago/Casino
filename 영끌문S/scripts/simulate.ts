// npm run sim [games] [seconds] — how the charts behave and how hard the game is under the current CONFIG
// (DESIGN.md section 4). Every game is a fresh market started at the start prices, exactly like the app, and
// lasts timing.sessionSec unless another length is given.
//
// Part A, the charts: return after the game, how often each stock ends up, and how readable the chart is:
//   persist  P(the next 10 s go the same way as the last 10 s), and the same for 30 s (the scale of the chart
//            formations). A coin flip is 50%; a smooth trend is 80%+.
//   smooth   |net move| / path length over 30-second windows (efficiency ratio). A random walk sampled every
//            second is about 0.18; a stock that quotes only every few seconds reads higher.
// Part B, the players: bots play the whole game through the real account rules (fees, liquidation, leverage
// unlocked at econ.leverageFrom) and settle at the end. Like a person, a bot looks at the chart once a second,
// clicks 0.2-0.4 s later, and the order fills after the stock's fill delay (volume.fillDelay) at the price of
// that moment. Columns are over the games: how often they finish with a profit, with 2× or more and with
// 10× or more, and the average finish.
import { CONFIG, type Range } from '../src/config.ts';
import { buy, equity, liquidate, maxMargin, newAccount, sell, type Account } from '../src/game/account.ts';
import { Market } from '../src/game/market.ts';
import { between, seededRng, type Rng } from '../src/rng.ts';

const GAMES = Number(process.argv[2]) || 1000;
const SECONDS = Number(process.argv[3]) || CONFIG.timing.sessionSec || 300;
const SEED = 20261019;
const econ = CONFIG.economy;
const TPS = 1000 / CONFIG.timing.tickMs;
const STOCKS = [...CONFIG.stocks].sort((a, b) => a.difficulty - b.difficulty);
const IDS = STOCKS.map((s) => s.id);
const NAME: Record<string, string> = Object.fromEntries(STOCKS.map((s) => [s.id, s.name]));
const FILL: Record<string, Range> = Object.fromEntries(STOCKS.map((s) => [s.id, s.volume.fillDelay]));
const DEP = econ.deposit;
const REACTION: Range = [2, 4]; // ticks between seeing the chart and the click

// ------------------------------------------------------------------ bots
interface View {
  tick: number;
  sec: number;
  seen: Record<string, number>; // prices at the last whole second: what the decision is based on
  prices: Record<string, number>; // prices now: what an order fills at
  hist: Record<string, number[]>; // price at every whole second, index = second
  rng: Rng;
}
interface Order {
  fillAt: number; // tick
  id: string;
  kind: 'buy' | 'sell';
  leverage: number;
  share: number; // of the cash (buy) or of the position (sell), taken at the fill
}
interface Bot {
  name: string;
  acc: Account;
  stopped: boolean;
  orders: Order[]; // waiting for their fill; the bot does not decide again until they are done
  nextAt?: number; // tick of the next decision
  memo: { entrySec?: number; phase?: number };
  brain: (b: Bot, v: View) => void;
}

/** Equity as the player saw it. */
const eq = (b: Bot, v: View): number => equity(b.acc, v.seen);
const holding = (b: Bot): string[] => Object.keys(b.acc.positions);
/** The highest leverage the rules allow right now, capped. */
const allowedLeverage = (b: Bot, v: View, cap: number): number =>
  eq(b, v) >= econ.leverageFrom ? Math.max(...econ.leverages.filter((L) => L <= cap)) : 1;

/** Sends an order: it fills now on a stock without fill delay, else after the delay at the price by then. */
function place(b: Bot, v: View, order: Omit<Order, 'fillAt'>): void {
  const delay = Math.round(between(v.rng, FILL[order.id]) * TPS);
  if (delay <= 0) fill(b, v, order);
  else b.orders.push({ ...order, fillAt: v.tick + delay });
}
function fill(b: Bot, v: View, o: Omit<Order, 'fillAt'>): void {
  if (o.kind === 'sell') {
    const r = sell(b.acc, o.id, v.prices[o.id], o.share, econ);
    if (r.ok) b.acc = r.account;
    return;
  }
  const L = b.acc.positions[o.id]?.leverage ?? o.leverage;
  const margin = Math.floor(maxMargin(b.acc.cash, L, econ) * o.share * 100) / 100;
  if (margin < econ.minOrder) return;
  const r = buy(b.acc, o.id, v.prices[o.id], margin, L, econ, equity(b.acc, v.prices));
  if (r.ok) {
    b.acc = r.account;
    b.memo.entrySec = v.sec;
  }
}
const buyShare = (b: Bot, v: View, id: string, leverage: number, share = 1): void =>
  place(b, v, { id, kind: 'buy', leverage, share });
const sellShare = (b: Bot, v: View, id: string, share = 1): void => place(b, v, { id, kind: 'sell', leverage: 0, share });
const sellAll = (b: Bot, v: View): void => holding(b).forEach((id) => sellShare(b, v, id));
function stop(b: Bot, v: View): void {
  sellAll(b, v);
  b.stopped = true;
}

/** Return over the last n seconds. */
const ret = (v: View, id: string, n: number): number => {
  const h = v.hist[id];
  return v.sec >= n ? h[v.sec] / h[v.sec - n] - 1 : 0;
};
/** Typical size of a 10-second move lately (std of overlapping 10-s returns over the last minute). */
function vol10(v: View, id: string): number {
  const h = v.hist[id];
  const from = Math.max(10, v.sec - 60);
  let s = 0;
  let n = 0;
  for (let t = from; t <= v.sec; t++) {
    const r = Math.log(h[t] / h[t - 10]);
    s += r * r;
    n++;
  }
  return n > 5 ? Math.sqrt(s / n) : Infinity;
}
const posGain = (b: Bot, v: View, id: string): number => {
  const p = b.acc.positions[id];
  return p ? (p.qty * (v.seen[id] - p.entry)) / p.margin : 0;
};

/**
 * Buy one stock at 1× at the start and hold it; with `target`, settle as soon as the equity is seen at it
 * (2.2×, a little over 2× because the fill comes a moment later).
 */
const holdBot = (id: string, target = Infinity, label = '존버'): Bot => ({
  name: `${label} ${NAME[id]}`,
  acc: newAccount(econ),
  stopped: false,
  orders: [],
  memo: {},
  brain(b, v) {
    if (eq(b, v) >= target) return stop(b, v);
    if (holding(b).length === 0 && !b.memo.phase) {
      b.memo.phase = 1; // buys once
      buyShare(b, v, id, 1);
    }
  },
});

/** Chases the strongest 10-second move, at up to `cap`× once leverage unlocks; cuts on a reversal. */
const momentumBot = (cap: number): Bot => ({
  name: `추세 추종 (최대 ${cap}×)`,
  acc: newAccount(econ),
  stopped: false,
  orders: [],
  memo: {},
  brain(b, v) {
    if (v.sec < 12) return;
    if (eq(b, v) >= 10 * DEP) return stop(b, v);
    const [held] = holding(b);
    if (held) {
      const z = ret(v, held, 10) / vol10(v, held);
      if (z < -0.5 || posGain(b, v, held) < -0.3) sellShare(b, v, held);
      return;
    }
    let best = '';
    let bestZ = 1;
    for (const id of IDS) {
      const z = ret(v, id, 10) / vol10(v, id);
      if (z > bestZ) [best, bestZ] = [id, z];
    }
    if (best) buyShare(b, v, best, allowedLeverage(b, v, cap));
  },
});

/** Buys sharp 10-second drops, sells the bounce (or gives up after 20 s). */
const dipBot = (cap: number): Bot => ({
  name: `저점 매수 (최대 ${cap}×)`,
  acc: newAccount(econ),
  stopped: false,
  orders: [],
  memo: {},
  brain(b, v) {
    if (v.sec < 12) return;
    if (eq(b, v) >= 10 * DEP) return stop(b, v);
    const [held] = holding(b);
    if (held) {
      const p = b.acc.positions[held];
      const move = v.seen[held] / p.entry - 1;
      const s = vol10(v, held);
      if (move > s || move < -1.5 * s || v.sec - (b.memo.entrySec ?? 0) >= 20) sellShare(b, v, held);
      return;
    }
    let worst = '';
    let worstZ = -1.5;
    for (const id of IDS) {
      const z = ret(v, id, 10) / vol10(v, id);
      if (z < worstZ) [worst, worstZ] = [id, z];
    }
    if (worst) buyShare(b, v, worst, allowedLeverage(b, v, cap));
  },
});

/** The last n seconds' high and low. */
function range(v: View, id: string, n: number): { hi: number; lo: number } {
  const h = v.hist[id];
  let hi = -Infinity;
  let lo = Infinity;
  for (let t = Math.max(0, v.sec - n); t <= v.sec; t++) {
    hi = Math.max(hi, h[t]);
    lo = Math.min(lo, h[t]);
  }
  return { hi, lo };
}

/** Trades the box: buys at the bottom of the last 30 seconds' range, sells at its top (or after 30 s). */
const rangeBot = (cap: number): Bot => ({
  name: `박스권 매매 (최대 ${cap}×)`,
  acc: newAccount(econ),
  stopped: false,
  orders: [],
  memo: {},
  brain(b, v) {
    if (v.sec < 32) return;
    if (eq(b, v) >= 10 * DEP) return stop(b, v);
    const [held] = holding(b);
    if (held) {
      const { hi, lo } = range(v, held, 30);
      const at = (v.seen[held] - lo) / (hi - lo || 1);
      if (at >= 0.8 || v.seen[held] < b.acc.positions[held].entry * (1 - 1.5 * vol10(v, held)) || v.sec - (b.memo.entrySec ?? 0) >= 30)
        sellShare(b, v, held);
      return;
    }
    let pick = '';
    let lowest = 0.15;
    for (const id of IDS) {
      const { hi, lo } = range(v, id, 30);
      if ((hi - lo) / lo < 1.5 * vol10(v, id)) continue; // no box worth trading
      const at = (v.seen[id] - lo) / (hi - lo);
      if (at < lowest) [pick, lowest] = [id, at];
    }
    if (pick) buyShare(b, v, pick, allowedLeverage(b, v, cap));
  },
});

/** A festival player clicking around: a random trade every few seconds, random stock, size and leverage. */
const antBot = (): Bot => ({
  name: '개미 (무작위)',
  acc: newAccount(econ),
  stopped: false,
  orders: [],
  memo: {},
  brain(b, v) {
    if (v.rng.float() >= 0.2) return;
    const held = holding(b);
    if (held.length && v.rng.coin()) {
      sellShare(b, v, held[v.rng.int(held.length)], v.rng.coin() ? 1 : 0.5);
      return;
    }
    const id = IDS[v.rng.int(IDS.length)];
    const open = eq(b, v) >= econ.leverageFrom ? econ.leverages : [1];
    buyShare(b, v, id, open[v.rng.int(open.length)], [0.25, 0.5, 1][v.rng.int(3)]);
  },
});

/** First doubles with 게이임스탑 at 1× (sold once 2.2× is seen), which unlocks leverage. */
function doubleFirst(b: Bot, v: View): boolean {
  const [held] = holding(b);
  if (held && b.acc.positions[held].leverage > 1) return false; // the leveraged stage is running
  if (eq(b, v) >= 2.2 * DEP && eq(b, v) >= econ.leverageFrom) {
    if (held) sellShare(b, v, held); // unlocked: cash in, go to the second stage
    return false;
  }
  if (eq(b, v) >= econ.leverageFrom) return false;
  if (!held) buyShare(b, v, 'gamestop', 1);
  return true;
}

/** Goes for 10×: doubles first, then puts everything at `lev`× on the strongest 10-second move and takes +50%. */
const gamblerBot = (lev: number): Bot => ({
  name: `한방 (2배 후 추세 ${lev}×)`,
  acc: newAccount(econ),
  stopped: false,
  orders: [],
  memo: {},
  brain(b, v) {
    if (eq(b, v) >= 10 * DEP) return stop(b, v);
    if (doubleFirst(b, v)) return;
    const [held] = holding(b);
    if (held) {
      if (posGain(b, v, held) >= 0.5) sellShare(b, v, held);
      return;
    }
    if (v.sec < 12) return;
    let best = '';
    let bestZ = 0.5;
    for (const id of IDS) {
      const z = ret(v, id, 10) / vol10(v, id);
      if (z > bestZ) [best, bestZ] = [id, z];
    }
    if (best) buyShare(b, v, best, lev);
  },
});

/** Goes for 10×: doubles first, then holds one stock at `lev`× until 10× (or the end). */
const doubleThenHoldBot = (id: string, lev: number): Bot => ({
  name: `2배 후 ${NAME[id]} ${lev}× 존버`,
  acc: newAccount(econ),
  stopped: false,
  orders: [],
  memo: {},
  brain(b, v) {
    if (eq(b, v) >= 10 * DEP) return stop(b, v);
    if (doubleFirst(b, v)) return;
    if (holding(b).length === 0) buyShare(b, v, id, lev);
  },
});

function makeBots(): Bot[] {
  return [
    ...IDS.map((id) => holdBot(id)),
    holdBot('gamestop', 2.2 * DEP, '2배 노리기'),
    antBot(),
    momentumBot(1),
    momentumBot(10),
    dipBot(1),
    dipBot(10),
    rangeBot(1),
    rangeBot(10),
    gamblerBot(10),
    gamblerBot(20),
    doubleThenHoldBot('kingka', 20),
    doubleThenHoldBot('lownix', 10),
    doubleThenHoldBot('mwodna', 10),
    doubleThenHoldBot('dolge', 10),
    doubleThenHoldBot('gamestop', 2),
  ];
}

// ------------------------------------------------------------------ run
interface Chart {
  ret: number[];
  persist: [number, number];
  persist30: [number, number];
  smooth: [number, number];
  rise5: number[];
  fall5: number[];
}
const charts: Record<string, Chart> = Object.fromEntries(
  IDS.map((id) => [id, { ret: [], persist: [0, 0], persist30: [0, 0], smooth: [0, 0], rise5: [], fall5: [] }]),
);
const finals: Record<string, number[]> = {};

const rng = seededRng(SEED);
const botRng = seededRng(SEED + 1);
for (let g = 0; g < GAMES; g++) {
  const market = new Market(rng);
  const bots = makeBots();
  const prices = market.prices();
  const hist: Record<string, number[]> = Object.fromEntries(IDS.map((id) => [id, [prices[id]]]));
  const seen = { ...prices };
  const view: View = { tick: 0, sec: 0, seen, prices, hist, rng: botRng };
  for (let t = 1; t <= SECONDS * TPS; t++) {
    market.step();
    view.tick = t;
    for (const s of market.stocks) prices[s.def.id] = s.price;
    for (const b of bots) {
      if (holding(b).length) {
        const r = liquidate(b.acc, prices, econ);
        if (r.fills.length) b.acc = r.account;
      }
      if (b.orders.length && b.orders[0].fillAt <= t) {
        const due = b.orders.filter((o) => o.fillAt <= t);
        b.orders = b.orders.filter((o) => o.fillAt > t);
        for (const o of due) fill(b, view, o);
      }
    }
    if (t % TPS === 0) {
      view.sec = t / TPS;
      for (const id of IDS) hist[id].push((seen[id] = prices[id]));
      for (const b of bots) b.nextAt = t + REACTION[0] + botRng.int(REACTION[1] - REACTION[0] + 1);
    }
    // Decide on what the chart showed at the last whole second; the order goes in at the click.
    for (const b of bots) if (!b.stopped && !b.orders.length && b.nextAt === t) b.brain(b, view);
  }
  for (const b of bots) {
    // The close: orders still waiting are dropped and everything held is sold at the closing price.
    b.orders = [];
    for (const id of holding(b)) fill(b, view, { id, kind: 'sell', leverage: 0, share: 1 });
    (finals[b.name] ??= []).push(b.acc.cash / DEP);
  }
  for (const id of IDS) {
    const h = hist[id];
    const c = charts[id];
    c.ret.push(h[SECONDS] / h[0] - 1);
    for (const [n, p] of [[10, c.persist], [30, c.persist30]] as const) {
      for (let s = n; s + n <= SECONDS; s += n) {
        const a = h[s] - h[s - n];
        const z = h[s + n] - h[s];
        if (a && z) {
          p[0] += Math.sign(a) === Math.sign(z) ? 1 : 0;
          p[1]++;
        }
      }
    }
    for (let s = 0; s + 30 <= SECONDS; s += 30) {
      let path = 0;
      for (let k = s + 1; k <= s + 30; k++) path += Math.abs(Math.log(h[k] / h[k - 1]));
      c.smooth[0] += path ? Math.abs(Math.log(h[s + 30] / h[s])) / path : 0;
      c.smooth[1]++;
    }
    let rise = 0;
    let fall = 0;
    for (let s = 5; s <= SECONDS; s++) {
      const r = h[s] / h[s - 5] - 1;
      rise = Math.max(rise, r);
      fall = Math.min(fall, r);
    }
    c.rise5.push(rise);
    c.fall5.push(fall);
  }
}

// ------------------------------------------------------------------ report
const mean = (xs: number[]): number => xs.reduce((s, x) => s + x, 0) / xs.length;
const q = (xs: number[], p: number): number => [...xs].sort((a, b) => a - b)[Math.floor(p * (xs.length - 1))];
const share = (xs: number[], f: (x: number) => boolean): string => `${((xs.filter(f).length / xs.length) * 100).toFixed(1)}%`;
const pct = (v: number): string => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%`;
const times = (v: number): string => `${v.toFixed(2)}×`;

console.log(`\n영끌문S 시뮬레이션 — seed ${SEED}, ${GAMES}게임, 게임당 ${SECONDS}초\n`);
console.log('A. 차트\n');
console.log('| 종목 | 난이도 | 평균 | p5 / p50 / p95 | 오른 게임 | 방향 지속 10초 / 30초 | 매끄러움 | 5초 최대 상승 / 하락 (평균) |');
console.log('|---|---|---|---|---|---|---|---|');
for (const s of STOCKS) {
  const c = charts[s.id];
  console.log(
    `| ${s.name} | ${'★'.repeat(s.difficulty)} | ${pct(mean(c.ret))} | ${pct(q(c.ret, 0.05))} / ${pct(q(c.ret, 0.5))} / ${pct(q(c.ret, 0.95))} | ${share(c.ret, (r) => r > 0)} | ${((c.persist[0] / c.persist[1]) * 100).toFixed(1)}% / ${((c.persist30[0] / c.persist30[1]) * 100).toFixed(1)}% | ${(c.smooth[0] / c.smooth[1]).toFixed(2)} | ${pct(mean(c.rise5))} / ${pct(mean(c.fall5))} |`,
  );
}
console.log('\nB. 플레이어 (게임 끝에 정산한 금액 ÷ 기본예탁금)\n');
console.log('| 전략 | 수익 | 2배 이상 | 10배 이상 | 평균 | p50 | p99 |');
console.log('|---|---|---|---|---|---|---|');
for (const [name, xs] of Object.entries(finals)) {
  console.log(
    `| ${name} | ${share(xs, (x) => x > 1)} | ${share(xs, (x) => x >= 2)} | ${share(xs, (x) => x >= 10)} | ${times(mean(xs))} | ${times(q(xs, 0.5))} | ${times(q(xs, 0.99))} |`,
  );
}
