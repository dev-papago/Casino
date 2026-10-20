// npm run sim [games] [minutes] — how the charts behave and how hard the game is under the current CONFIG
// (DESIGN.md section 4). Every game is a fresh market started at the start prices, exactly like the app. There is
// no market close, so each game runs for the given minutes (default 30) and the results are read as if the
// player had settled after 5, 15 and 30 minutes.
//
// Part A, the charts: return after 5 and 30 minutes, how often each stock is up after 5 minutes, and how readable
// the chart is:
//   persist  P(the next 10 s go the same way as the last 10 s), and the same for 30 s (the scale of the chart
//            formations). A coin flip is 50%; a smooth trend is 80%+.
//   smooth   |net move| / path length over 30-second windows (efficiency ratio). A random walk sampled every
//            second is about 0.18; a stock that quotes only every few seconds reads higher.
// Part B, the players: bots play through the real account rules (fees, liquidation, leverage unlocked at
// econ.leverageFrom, 매수 and 인버스). Like a person, a bot looks at the chart once a second, clicks 0.2-0.4 s
// later, and the order fills after the stock's fill delay (volume.fillDelay) at the price of that moment.
// Columns are over the games: how often the player is up, at 2× or more and at 10× or more when settling at that
// minute, and the average.
import { CONFIG, type Range } from '../src/config.ts';
import { buy, equity, liquidate, maxMargin, newAccount, sell, type Account } from '../src/game/account.ts';
import { Market } from '../src/game/market.ts';
import { between, seededRng, type Rng } from '../src/rng.ts';

const GAMES = Number(process.argv[2]) || 1000;
const MINUTES = Number(process.argv[3]) || 30;
const SECONDS = MINUTES * 60;
const CHECKS = [5, 15, 30].filter((m) => m <= MINUTES).map((m) => m * 60);
const SEED = 20261020;
const econ = CONFIG.economy;
const TPS = 1000 / CONFIG.timing.tickMs;
const WINDOW = CONFIG.timing.eventWindowSec;
const STOCKS = [...CONFIG.stocks].sort((a, b) => a.difficulty - b.difficulty);
const IDS = STOCKS.map((s) => s.id);
const NAME: Record<string, string> = Object.fromEntries(STOCKS.map((s) => [s.id, s.name]));
const FILL: Record<string, Range> = Object.fromEntries(STOCKS.map((s) => [s.id, s.volume.fillDelay]));
const LIMIT: Record<string, number> = Object.fromEntries(STOCKS.map((s) => [s.id, s.maxLeverage]));
const DEP = econ.deposit;
const MAX_LEV = Math.max(...econ.leverages);
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
  inverse: boolean;
  share: number; // of the cash (buy) or of the position (sell), taken at the fill
}
interface Bot {
  name: string;
  acc: Account;
  stopped: boolean;
  orders: Order[]; // waiting for their fill; the bot does not decide again until they are done
  nextAt?: number; // tick of the next decision
  memo: { entrySec?: number; phase?: number; window?: number };
  brain: (b: Bot, v: View) => void;
}
const bot = (name: string, brain: Bot['brain']): Bot => ({ name, acc: newAccount(econ), stopped: false, orders: [], memo: {}, brain });

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
  // Above the stock's limit the app greys the button out; a bot gets the highest leverage the stock allows.
  const L = b.acc.positions[o.id]?.leverage ?? Math.max(...econ.leverages.filter((x) => x <= Math.min(o.leverage, LIMIT[o.id])));
  const margin = Math.floor(maxMargin(b.acc.cash, L, econ) * o.share * 100) / 100;
  if (margin < econ.minOrder) return;
  const order = { stockId: o.id, price: v.prices[o.id], margin, leverage: L, inverse: o.inverse, maxLeverage: LIMIT[o.id] };
  const r = buy(b.acc, order, econ, equity(b.acc, v.prices));
  if (r.ok) {
    b.acc = r.account;
    b.memo.entrySec = v.sec;
  }
}
/** Opens (or adds to) a position: 매수 when `inverse` is false, 인버스 when true. */
const open = (b: Bot, v: View, id: string, leverage: number, inverse = false, share = 1): void =>
  place(b, v, { id, kind: 'buy', leverage, inverse, share });
const sellShare = (b: Bot, v: View, id: string, share = 1): void =>
  place(b, v, { id, kind: 'sell', leverage: 0, inverse: false, share });
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
/** The position's gain on its margin, as seen. */
const posGain = (b: Bot, v: View, id: string): number => {
  const p = b.acc.positions[id];
  return p ? ((p.inverse ? -1 : 1) * p.qty * (v.seen[id] - p.entry)) / p.margin : 0;
};
/** The position's price move in its favour since the entry. */
const posMove = (b: Bot, v: View, id: string): number => {
  const p = b.acc.positions[id];
  return p ? (p.inverse ? -1 : 1) * (v.seen[id] / p.entry - 1) : 0;
};

/**
 * Opens one stock at 1× (or `lev`× once allowed) at the start and holds it; with `target`, settles as soon as
 * the equity is seen at that multiple of the deposit.
 */
const holdBot = (id: string, inverse: boolean, target = Infinity, label = '존버'): Bot =>
  bot(`${label} ${NAME[id]}${inverse ? ' 인버스' : ''}`, (b, v) => {
    if (eq(b, v) >= target * DEP) return stop(b, v);
    if (!b.memo.phase) {
      b.memo.phase = 1; // opens once
      open(b, v, id, 1, inverse);
    }
  });

/** Chases the strongest 10-second move either way (매수 up, 인버스 down); cuts on a reversal. */
const momentumBot = (cap: number): Bot =>
  bot(`추세 추종 (최대 ${cap}×)`, (b, v) => {
    if (v.sec < 12) return;
    if (eq(b, v) >= 10 * DEP) return stop(b, v);
    const [held] = holding(b);
    if (held) {
      const p = b.acc.positions[held];
      const z = ((p.inverse ? -1 : 1) * ret(v, held, 10)) / vol10(v, held);
      if (z < -0.5 || posGain(b, v, held) < -0.3) sellShare(b, v, held);
      return;
    }
    let best = '';
    let bestZ = 0;
    for (const id of IDS) {
      const z = ret(v, id, 10) / vol10(v, id);
      if (Math.abs(z) > 1 && Math.abs(z) > Math.abs(bestZ)) [best, bestZ] = [id, z];
    }
    if (best) open(b, v, best, allowedLeverage(b, v, cap), bestZ < 0);
  });

/** Fades sharp 10-second moves (매수 a drop, 인버스 a jump), takes the bounce or gives up after 20 s. */
const fadeBot = (cap: number): Bot =>
  bot(`반대 매매 (최대 ${cap}×)`, (b, v) => {
    if (v.sec < 12) return;
    if (eq(b, v) >= 10 * DEP) return stop(b, v);
    const [held] = holding(b);
    if (held) {
      const move = posMove(b, v, held);
      const s = vol10(v, held);
      if (move > s || move < -1.5 * s || v.sec - (b.memo.entrySec ?? 0) >= 20) sellShare(b, v, held);
      return;
    }
    let pick = '';
    let pickZ = 0;
    for (const id of IDS) {
      const z = ret(v, id, 10) / vol10(v, id);
      if (Math.abs(z) > 1.5 && Math.abs(z) > Math.abs(pickZ)) [pick, pickZ] = [id, z];
    }
    if (pick) open(b, v, pick, allowedLeverage(b, v, cap), pickZ > 0);
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

/** Trades the box: 매수 at the bottom of the last 30 seconds' range, 인버스 at its top; out at the other side or after 30 s. */
const rangeBot = (cap: number): Bot =>
  bot(`박스권 매매 (최대 ${cap}×)`, (b, v) => {
    if (v.sec < 32) return;
    if (eq(b, v) >= 10 * DEP) return stop(b, v);
    const [held] = holding(b);
    if (held) {
      const p = b.acc.positions[held];
      const { hi, lo } = range(v, held, 30);
      const at = (v.seen[held] - lo) / (hi - lo || 1);
      if ((p.inverse ? at <= 0.2 : at >= 0.8) || posMove(b, v, held) < -1.5 * vol10(v, held) || v.sec - (b.memo.entrySec ?? 0) >= 30)
        sellShare(b, v, held);
      return;
    }
    let pick = '';
    let edge = 0.15;
    let inverse = false;
    for (const id of IDS) {
      const { hi, lo } = range(v, id, 30);
      if ((hi - lo) / lo < 1.5 * vol10(v, id)) continue; // no box worth trading
      const at = (v.seen[id] - lo) / (hi - lo);
      if (at < edge) [pick, edge, inverse] = [id, at, false];
      if (1 - at < edge) [pick, edge, inverse] = [id, 1 - at, true];
    }
    if (pick) open(b, v, pick, allowedLeverage(b, v, cap), inverse);
  });

/**
 * Watches for a 급등·급락 (a 2-second move of 4 typical 10-second moves or more) and trades right after it:
 * along it (`follow`) or against it, out after `holdSec`.
 */
const eventBot = (follow: boolean, holdSec: number, cap: number): Bot =>
  bot(`급등락 ${follow ? '따라가기' : '반대로'} ${holdSec}초 (최대 ${cap}×)`, (b, v) => {
    if (v.sec < 12) return;
    if (eq(b, v) >= 10 * DEP) return stop(b, v);
    const [held] = holding(b);
    if (held) {
      if (v.sec - (b.memo.entrySec ?? 0) >= holdSec) sellShare(b, v, held);
      return;
    }
    for (const id of IDS) {
      const r = ret(v, id, 2);
      if (Math.abs(r) > 4 * vol10(v, id)) return open(b, v, id, allowedLeverage(b, v, cap), follow ? r < 0 : r > 0);
    }
  });

/**
 * The 2-minute rule: once a stock's 급등·급락 has happened in this window, no other can until the next one.
 * After the event, holds `id` (매수 or 인버스) until the window ends.
 */
const windowBot = (id: string, inverse: boolean, cap: number): Bot =>
  bot(`이벤트 후 구간 끝까지 ${NAME[id]}${inverse ? ' 인버스' : ''} ${cap}×`, (b, v) => {
    if (eq(b, v) >= 10 * DEP) return stop(b, v);
    const w = Math.floor(v.sec / WINDOW);
    const [held] = holding(b);
    if (held) {
      if (w !== b.memo.window) sellShare(b, v, held);
      return;
    }
    if (v.sec < 12 || b.memo.phase === w + 1 || WINDOW - (v.sec % WINDOW) < 10) return;
    if (Math.abs(ret(v, id, 2)) > 4 * vol10(v, id)) {
      b.memo.phase = w + 1; // one trade per window
      b.memo.window = w;
      open(b, v, id, allowedLeverage(b, v, cap), inverse);
    }
  });

/** Waits for a big run-up (90 s, three typical 90-second moves) that starts to turn, and rides the fall with 인버스 for 40 s: a bubble's peak. */
const peakBot = (cap: number): Bot =>
  bot(`꼭대기 인버스 (최대 ${cap}×)`, (b, v) => {
    if (v.sec < 92) return;
    if (eq(b, v) >= 10 * DEP) return stop(b, v);
    const [held] = holding(b);
    if (held) {
      if (v.sec - (b.memo.entrySec ?? 0) >= 40) sellShare(b, v, held);
      return;
    }
    for (const id of IDS) {
      const s90 = 3 * vol10(v, id);
      if (ret(v, id, 90) > 3 * s90 && ret(v, id, 10) < -vol10(v, id)) return open(b, v, id, allowedLeverage(b, v, cap), true);
    }
  });

/** A festival player clicking around: a random trade every few seconds, random stock, direction, size and leverage. */
const antBot = (): Bot =>
  bot('개미 (무작위)', (b, v) => {
    if (v.rng.float() >= 0.2) return;
    const held = holding(b);
    if (held.length && v.rng.coin()) {
      sellShare(b, v, held[v.rng.int(held.length)], v.rng.coin() ? 1 : 0.5);
      return;
    }
    const id = IDS[v.rng.int(IDS.length)];
    const levs = eq(b, v) >= econ.leverageFrom ? econ.leverages : [1];
    const inverse = b.acc.positions[id]?.inverse ?? v.rng.float() < 0.3;
    open(b, v, id, levs[v.rng.int(levs.length)], inverse, [0.25, 0.5, 1][v.rng.int(3)]);
  });

/** First doubles with 게이임스탑 매수 at 1× (sold once 2.2× is seen), which unlocks leverage. */
function doubleFirst(b: Bot, v: View): boolean {
  const [held] = holding(b);
  if (held && b.acc.positions[held].leverage > 1) return false; // the leveraged stage is running
  if (eq(b, v) >= 2.2 * DEP && eq(b, v) >= econ.leverageFrom) {
    if (held) sellShare(b, v, held); // unlocked: cash in, go to the second stage
    return false;
  }
  if (eq(b, v) >= econ.leverageFrom) return false;
  if (!held) open(b, v, 'gamestop', 1);
  return true;
}

/** Goes for 10×: doubles first, then puts everything at 10× on the strongest 10-second move either way and takes +50%. */
const gamblerBot = (): Bot =>
  bot(`한방 (2배 후 추세 ${MAX_LEV}×)`, (b, v) => {
    if (eq(b, v) >= 10 * DEP) return stop(b, v);
    if (doubleFirst(b, v)) return;
    const [held] = holding(b);
    if (held) {
      if (posGain(b, v, held) >= 0.5) sellShare(b, v, held);
      return;
    }
    if (v.sec < 12) return;
    let best = '';
    let bestZ = 0;
    for (const id of IDS) {
      const z = ret(v, id, 10) / vol10(v, id);
      if (Math.abs(z) > 0.5 && Math.abs(z) > Math.abs(bestZ)) [best, bestZ] = [id, z];
    }
    if (best) open(b, v, best, MAX_LEV, bestZ < 0);
  });

/** Goes for 10×: doubles first, then holds one stock at `lev`× (매수 or 인버스) until 10×, reopening after a liquidation. */
const doubleThenHoldBot = (id: string, lev: number, inverse: boolean): Bot =>
  bot(`2배 후 ${NAME[id]}${inverse ? ' 인버스' : ''} ${lev}× 존버`, (b, v) => {
    if (eq(b, v) >= 10 * DEP) return stop(b, v);
    if (doubleFirst(b, v)) return;
    if (holding(b).length === 0) open(b, v, id, lev, inverse);
  });

function makeBots(): Bot[] {
  return [
    ...IDS.map((id) => holdBot(id, false)),
    ...IDS.map((id) => holdBot(id, true)),
    holdBot('gamestop', false, 2.2, '2배 노리기'),
    holdBot('gamestop', true, 2.2, '2배 노리기'),
    antBot(),
    momentumBot(1),
    momentumBot(MAX_LEV),
    fadeBot(1),
    fadeBot(MAX_LEV),
    rangeBot(1),
    rangeBot(MAX_LEV),
    eventBot(true, 5, 1),
    eventBot(false, 20, 1),
    eventBot(false, 20, MAX_LEV),
    windowBot('lownix', false, MAX_LEV),
    windowBot('mwodna', true, MAX_LEV),
    windowBot('kingka', false, MAX_LEV),
    peakBot(1),
    peakBot(MAX_LEV),
    gamblerBot(),
    ...IDS.map((id) => doubleThenHoldBot(id, LIMIT[id], false)),
    ...IDS.map((id) => doubleThenHoldBot(id, LIMIT[id], true)),
  ];
}

// ------------------------------------------------------------------ run
interface Chart {
  ret5: number[];
  retEnd: number[];
  persist: [number, number];
  persist30: [number, number];
  smooth: [number, number];
  rise5: number[];
  fall5: number[];
}
const charts: Record<string, Chart> = Object.fromEntries(
  IDS.map((id) => [id, { ret5: [], retEnd: [], persist: [0, 0], persist30: [0, 0], smooth: [0, 0], rise5: [], fall5: [] }]),
);
const results: Record<string, number[][]> = {}; // bot → per checkpoint → finishes
const settled = (b: Bot, prices: Record<string, number>): number => equity(b.acc, prices) / DEP;

const rng = seededRng(SEED);
const botRng = seededRng(SEED + 1);
const started = Date.now();
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
      const k = CHECKS.indexOf(view.sec);
      if (k >= 0) for (const b of bots) ((results[b.name] ??= CHECKS.map(() => []))[k]).push(settled(b, prices));
    }
    // Decide on what the chart showed at the last whole second; the order goes in at the click.
    for (const b of bots) if (!b.stopped && !b.orders.length && b.nextAt === t) b.brain(b, view);
  }
  for (const id of IDS) {
    const h = hist[id];
    const c = charts[id];
    c.ret5.push(h[Math.min(300, SECONDS)] / h[0] - 1);
    c.retEnd.push(h[SECONDS] / h[0] - 1);
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
    for (let s = 5; s <= Math.min(300, SECONDS); s++) {
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
const mins = CHECKS.map((s) => `${s / 60}분`).join(' / ');

console.log(`\n영끌문S 시뮬레이션 — seed ${SEED}, ${GAMES}게임, 게임당 ${MINUTES}분 (${((Date.now() - started) / 1000).toFixed(0)}초 걸림)\n`);
console.log('A. 차트\n');
console.log(`| 종목 | 난이도 | 5분 평균 | 5분 p5 / p50 / p95 | 5분 뒤 오름 | ${MINUTES}분 평균 | ${MINUTES}분 p50 | ${MINUTES}분 뒤 오름 | 방향 지속 10초 / 30초 | 매끄러움 | 5초 최대 상승 / 하락 |`);
console.log('|---|---|---|---|---|---|---|---|---|---|---|');
for (const s of STOCKS) {
  const c = charts[s.id];
  console.log(
    `| ${s.name} | ${'★'.repeat(s.difficulty)} | ${pct(mean(c.ret5))} | ${pct(q(c.ret5, 0.05))} / ${pct(q(c.ret5, 0.5))} / ${pct(q(c.ret5, 0.95))} | ${share(c.ret5, (r) => r > 0)} | ${pct(mean(c.retEnd))} | ${pct(q(c.retEnd, 0.5))} | ${share(c.retEnd, (r) => r > 0)} | ${((c.persist[0] / c.persist[1]) * 100).toFixed(1)}% / ${((c.persist30[0] / c.persist30[1]) * 100).toFixed(1)}% | ${(c.smooth[0] / c.smooth[1]).toFixed(2)} | ${pct(mean(c.rise5))} / ${pct(mean(c.fall5))} |`,
  );
}
console.log(`\nB. 플레이어 (그 시각에 정산한 금액 ÷ 기본예탁금; ${mins})\n`);
console.log('| 전략 | 수익 | 2배 이상 | 10배 이상 | 평균 |');
console.log('|---|---|---|---|---|');
for (const [name, per] of Object.entries(results)) {
  const col = (f: (xs: number[]) => string): string => per.map(f).join(' / ');
  console.log(
    `| ${name} | ${col((xs) => share(xs, (x) => x > 1))} | ${col((xs) => share(xs, (x) => x >= 2))} | ${col((xs) => share(xs, (x) => x >= 10))} | ${col((xs) => times(mean(xs)))} |`,
  );
}
