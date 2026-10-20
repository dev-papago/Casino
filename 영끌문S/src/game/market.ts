// Price simulation (DESIGN.md section 2). Every stock moves on the same tick clock. Each tick the log of its true
// price changes by the noise every stock gets, 돌지코인's waves, the chart formation being played (patterns.ts)
// and the 급등·급락 events with their drift (events.ts). Each part leaves the expected price (practically) where
// it is, so with 매수 and 인버스 both open and no market close, neither direction pays on average: a stock's
// tendency is the shape of its moves (creeps up and sometimes crashes, slides down and sometimes spikes), not
// free money. What players see and trade is the quote: it catches up with the true price only when the stock
// trades, which a busy stock does every tick and a quiet one every few seconds (volume). Candles are built from
// quotes, so a candle's high and low are the extreme quotes inside it. The RNG is injected: crypto in the app,
// seeded in tests and the sim.
import { CONFIG, type GameConfig, type NoiseDef, type Range, type StockDef, type WaveDef } from '../config.ts';
import { between, gauss, meanExp, type Rng } from '../rng.ts';
import { makeEvents } from './events.ts';
import { makePatterns } from './patterns.ts';

export interface Candle {
  o: number;
  h: number;
  l: number;
  c: number;
}

export interface Trend {
  /** Log-price change for one tick from the waves alone, given the current log price. */
  step(x: number): number;
  /** Moves the trend's internal log levels by d (the history is shifted to end at the start price). */
  shift(d: number): void;
}

export interface Stock {
  def: StockDef;
  x: number; // log of the true price, which moves every tick
  price: number; // the quote: shown and traded; it catches up with the true price whenever the stock trades
  candles: Candle[]; // closed, oldest first
  live: Candle; // being built this candle
}

/** Everything that moves one stock. */
interface Engine {
  trend: Trend;
  noise: () => number;
  patterns: () => number;
  events: () => number;
  quoteGap: () => number; // ticks until the next quote
  nextQuote: number;
}

const SOFT_PULL = 0.05; // per second, outside a stock's bounds
const HARD_LIMIT: readonly [number, number] = [0.01, 100]; // multiples of start, never crossed
const TAU = 2 * Math.PI;

export class Market {
  readonly stocks: Stock[];
  ticks = 0; // since the game started (history excluded)
  private clock = 0; // ticks since the market was made (history included)
  private sub = 0; // ticks into the live candle
  private readonly cfg: GameConfig;
  private readonly engines: Engine[];
  private readonly dt: number;

  constructor(rng: Rng, cfg: GameConfig = CONFIG) {
    this.cfg = cfg;
    const dt = (this.dt = cfg.timing.tickMs / 1000);
    this.engines = cfg.stocks.map((s) => {
      const quoteTicks = s.volume.quoteSec / dt;
      return {
        trend: s.wave ? wave(s.wave, rng, dt) : FLAT,
        noise: makeNoise(s.noise, rng, dt),
        patterns: makePatterns(s.patterns, rng, dt),
        events: makeEvents(s.events, rng, dt, cfg.timing.eventWindowSec),
        quoteGap: () => (quoteTicks <= 1 ? 1 : Math.max(1, Math.round(-Math.log(1 - rng.float()) * quoteTicks))),
        nextQuote: 0,
      };
    });
    this.engines.forEach((e) => (e.nextQuote = e.quoteGap()));
    this.stocks = cfg.stocks.map((def) => {
      const p = def.start;
      return { def, x: Math.log(p), price: p, candles: [], live: { o: p, h: p, l: p, c: p } };
    });
    this.buildHistory();
  }

  get(id: string): Stock {
    const s = this.stocks.find((st) => st.def.id === id);
    if (!s) throw new Error(`unknown stock ${id}`);
    return s;
  }

  prices(): Record<string, number> {
    return Object.fromEntries(this.stocks.map((s) => [s.def.id, s.price]));
  }

  /** Advances every stock by one tick. */
  step(): void {
    this.advance();
    this.ticks++;
  }

  private advance(): void {
    const { ticksPerCandle, keepCandles } = this.cfg.timing;
    this.clock++;
    this.sub = (this.sub + 1) % ticksPerCandle;
    const closeCandle = this.sub === 0;
    this.stocks.forEach((s, i) => {
      const e = this.engines[i];
      const { start, bounds } = s.def;
      const lo = Math.log(start * bounds[0]);
      const hi = Math.log(start * bounds[1]);
      let dx = e.trend.step(s.x) + e.noise() + e.patterns() + e.events();
      if (s.x < lo) dx += SOFT_PULL * (lo - s.x) * this.dt;
      else if (s.x > hi) dx -= SOFT_PULL * (s.x - hi) * this.dt;
      s.x = clamp(s.x + (Number.isFinite(dx) ? dx : 0), Math.log(start * HARD_LIMIT[0]), Math.log(start * HARD_LIMIT[1]));
      if (this.clock >= e.nextQuote) {
        s.price = Math.exp(s.x);
        e.nextQuote = this.clock + e.quoteGap();
      }
      const c = s.live;
      c.c = s.price;
      if (s.price > c.h) c.h = s.price;
      if (s.price < c.l) c.l = s.price;
      if (closeCandle) {
        s.candles.push(c);
        if (s.candles.length > keepCandles + 100) s.candles.splice(0, s.candles.length - keepCandles);
        s.live = { o: s.price, h: s.price, l: s.price, c: s.price };
      }
    });
  }

  /** Runs the market through the history candles, then scales each history so it ends at the start price. */
  private buildHistory(): void {
    const n = this.cfg.timing.historyCandles * this.cfg.timing.ticksPerCandle;
    for (let t = 0; t < n; t++) this.advance();
    this.stocks.forEach((s, i) => {
      const d = Math.log(s.def.start) - Math.log(s.price);
      const k = Math.exp(d);
      for (const c of s.candles) {
        c.o *= k;
        c.h *= k;
        c.l *= k;
        c.c *= k;
      }
      this.engines[i].trend.shift(Math.log(s.def.start) - s.x);
      s.x = Math.log(s.def.start);
      s.price = s.def.start;
      s.live = { o: s.price, h: s.price, l: s.price, c: s.price };
    });
  }
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const FLAT: Trend = { step: () => 0, shift() {} };

/**
 * One tick of noise. The log volatility is an Ornstein-Uhlenbeck process (stationary spread `wander`), scaled so
 * the average variance stays vol²: calm and choppy stretches come and go without changing the overall size.
 * Each Gaussian step and each jump carries the small drift that keeps the expected price where it is.
 * Needles are a separate fast mean-reverting deviation, so they snap back instead of adding up.
 */
function makeNoise(n: NoiseDef, rng: Rng, dt: number): () => number {
  const keep = dt / n.wanderSec;
  const kick = n.wander * Math.sqrt(2 * keep);
  const scale = n.vol * Math.sqrt(dt);
  const needle = n.needle;
  const neg: Range = [-n.jumpSize[1], -n.jumpSize[0]];
  const jumpDrift = -Math.log1p(n.jumpRate * dt * ((meanExp(n.jumpSize) + meanExp(neg)) / 2 - 1));
  let h = n.wander * gauss(rng); // start somewhere in the stationary spread
  let dev = 0;
  return () => {
    h += -h * keep + kick * gauss(rng);
    const sd = scale * Math.exp(h - n.wander * n.wander);
    let dx = sd * gauss(rng) - (sd * sd) / 2 + jumpDrift;
    if (n.jumpRate > 0 && rng.float() < n.jumpRate * dt) dx += (rng.coin() ? 1 : -1) * between(rng, n.jumpSize);
    if (needle) {
      const before = dev;
      dev += -needle.revert * dev * dt + needle.vol * Math.sqrt(dt) * gauss(rng);
      if (rng.float() < needle.rate * dt) dev += (rng.coin() ? 1 : -1) * between(rng, needle.size);
      dx += dev - before;
    }
    return dx;
  };
}

function wave(m: WaveDef, rng: Rng, dt: number): Trend {
  const comps = m.waves.map((w) => ({ w, phase: rng.float() * TAU, speed: 0, amp: 0 }));
  const renew = (c: (typeof comps)[number]): void => {
    c.speed = (TAU / between(rng, c.w.periodSec)) * dt;
    c.amp = between(rng, c.w.amp);
  };
  comps.forEach(renew);
  let anchor = Number.NaN;
  return {
    step(x) {
      if (Number.isNaN(anchor)) anchor = x;
      anchor += m.anchorVol * Math.sqrt(dt) * gauss(rng);
      let drift = -m.revert * (x - anchor);
      for (const c of comps) {
        const half = Math.floor(c.phase / Math.PI);
        c.phase = (c.phase + c.speed) % TAU;
        if (Math.floor(c.phase / Math.PI) !== half) renew(c); // each half wave gets its own length and height
        drift += c.amp * Math.sin(c.phase);
      }
      return drift * dt;
    },
    shift(d) {
      anchor += d;
    },
  };
}

