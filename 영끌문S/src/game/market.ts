// Price simulation (DESIGN.md section 2). Every stock moves on the same tick clock; each tick a model
// returns the change of the log price. Candles are built from tick prices, so a candle's high and low
// are the extreme ticks inside it. The RNG is injected: crypto in the app, seeded in tests and the sim.
import {
  CONFIG,
  type CrashModel,
  type DecayModel,
  type GameConfig,
  type ModelDef,
  type SqueezeModel,
  type SteadyModel,
  type StockDef,
  type WaveModel,
} from '../config.ts';
import { between, gauss, type Rng } from '../rng.ts';

export interface Candle {
  o: number;
  h: number;
  l: number;
  c: number;
}

export interface PriceModel {
  /** Log-price change for one tick, given the current log price. */
  step(x: number): number;
  /** Moves the model's internal log levels by d (the history is shifted to end at the start price). */
  shift(d: number): void;
}

export interface Stock {
  def: StockDef;
  x: number; // log price
  price: number;
  candles: Candle[]; // closed, oldest first
  live: Candle; // being built this candle
}

const SOFT_PULL = 0.05; // per second, outside a stock's bounds
const HARD_LIMIT: readonly [number, number] = [0.01, 100]; // multiples of start, never crossed
const TAU = 2 * Math.PI;

export class Market {
  readonly stocks: Stock[];
  ticks = 0; // since the game started (history excluded)
  private sub = 0; // ticks into the live candle
  private readonly cfg: GameConfig;
  private readonly models: PriceModel[];
  private readonly dt: number;

  constructor(rng: Rng, cfg: GameConfig = CONFIG) {
    this.cfg = cfg;
    this.dt = cfg.timing.tickMs / 1000;
    this.models = cfg.stocks.map((s) => makeModel(s.model, rng, this.dt));
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
    this.sub = (this.sub + 1) % ticksPerCandle;
    const closeCandle = this.sub === 0;
    this.stocks.forEach((s, i) => {
      const { start, bounds } = s.def;
      const lo = Math.log(start * bounds[0]);
      const hi = Math.log(start * bounds[1]);
      let dx = this.models[i].step(s.x);
      if (s.x < lo) dx += SOFT_PULL * (lo - s.x) * this.dt;
      else if (s.x > hi) dx -= SOFT_PULL * (s.x - hi) * this.dt;
      s.x = clamp(s.x + (Number.isFinite(dx) ? dx : 0), Math.log(start * HARD_LIMIT[0]), Math.log(start * HARD_LIMIT[1]));
      s.price = Math.exp(s.x);
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

  /** Runs the models through the history candles, then scales each history so it ends at the start price. */
  private buildHistory(): void {
    const n = this.cfg.timing.historyCandles * this.cfg.timing.ticksPerCandle;
    for (let t = 0; t < n; t++) this.advance();
    this.stocks.forEach((s, i) => {
      const d = Math.log(s.def.start) - s.x;
      const k = Math.exp(d);
      for (const c of s.candles) {
        c.o *= k;
        c.h *= k;
        c.l *= k;
        c.c *= k;
      }
      this.models[i].shift(d);
      s.x = Math.log(s.def.start);
      s.price = s.def.start;
      s.live = { o: s.price, h: s.price, l: s.price, c: s.price };
    });
  }
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

export function makeModel(m: ModelDef, rng: Rng, dt: number): PriceModel {
  switch (m.kind) {
    case 'steady':
      return steady(m, rng, dt);
    case 'crash':
      return crash(m, rng, dt);
    case 'wave':
      return wave(m, rng, dt);
    case 'decay':
      return decay(m, rng, dt);
    case 'squeeze':
      return squeeze(m, rng, dt);
  }
}

/** Ticks in a random duration: exponential with the given mean (seconds), at least one tick. */
const expTicks = (rng: Rng, meanSec: number, dt: number): number =>
  Math.max(1, Math.round((-Math.log(1 - rng.float()) * meanSec) / dt));
const ticksIn = (rng: Rng, sec: readonly [number, number], dt: number): number =>
  Math.max(1, Math.round(between(rng, sec) / dt));

function steady(m: SteadyModel, rng: Rng, dt: number): PriceModel {
  const noise = m.vol * Math.sqrt(dt);
  let up = rng.float() < m.up.meanSec / (m.up.meanSec + m.down.meanSec);
  let left = expTicks(rng, up ? m.up.meanSec : m.down.meanSec, dt);
  let strength = between(rng, [0.5, 1.5]);
  return {
    step() {
      if (left-- <= 0) {
        up = !up;
        left = expTicks(rng, up ? m.up.meanSec : m.down.meanSec, dt);
        strength = between(rng, [0.5, 1.5]);
      }
      return (up ? m.up.drift : m.down.drift) * strength * dt + noise * gauss(rng);
    },
    shift() {},
  };
}

function crash(m: CrashModel, rng: Rng, dt: number): PriceModel {
  const noise = m.vol * Math.sqrt(dt);
  let low = Number.NaN; // log bottom since the last crash
  let left = 0; // crash ticks remaining
  let perTick = 0;
  return {
    step(x) {
      if (Number.isNaN(low) || x < low) low = x;
      if (left === 0) {
        const hazard = m.hazardBase + m.hazardSlope * Math.max(0, x - low - m.rallyFree);
        if (rng.float() >= hazard * dt) return m.drift * dt + noise * gauss(rng);
        left = ticksIn(rng, m.crashSec, dt);
        perTick = -between(rng, m.crashDrop) / left;
      }
      left--;
      const dx = perTick + 3 * noise * gauss(rng);
      if (left === 0) low = x + dx;
      return dx;
    },
    shift(d) {
      low += d;
    },
  };
}

function wave(m: WaveModel, rng: Rng, dt: number): PriceModel {
  const noise = m.vol * Math.sqrt(dt);
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
      return drift * dt + noise * gauss(rng);
    },
    shift(d) {
      anchor += d;
    },
  };
}

function decay(m: DecayModel, rng: Rng, dt: number): PriceModel {
  const noise = m.vol * Math.sqrt(dt);
  let mode: 'drift' | 'spike' | 'fade' = 'drift';
  let left = 0;
  let perTick = 0;
  let gain = 0;
  return {
    step() {
      if (mode === 'drift') {
        if (rng.float() >= m.spikeRate * dt) return m.drift * dt + noise * gauss(rng);
        mode = 'spike';
        gain = between(rng, m.spikeGain);
        left = ticksIn(rng, m.spikeSec, dt);
        perTick = gain / left;
      }
      const dx = perTick + (mode === 'spike' ? 2 : 1) * noise * gauss(rng);
      if (--left === 0) {
        if (mode === 'spike') {
          mode = 'fade';
          left = ticksIn(rng, m.fadeSec, dt);
          perTick = (-gain * between(rng, m.fadeShare)) / left + m.drift * dt;
        } else {
          mode = 'drift';
        }
      }
      return dx;
    },
    shift() {},
  };
}

function squeeze(m: SqueezeModel, rng: Rng, dt: number): PriceModel {
  const noise = m.vol * Math.sqrt(dt);
  const calmNoise = m.calmVol * Math.sqrt(dt);
  let base = Number.NaN; // normal log level the dumps fall back to
  let anchor = Number.NaN;
  let dev = 0;
  let mode: 'calm' | 'squeeze' | 'dump' = 'calm';
  let left = ticksIn(rng, m.calmSec, dt);
  let perTick = 0;
  return {
    step(x) {
      if (Number.isNaN(anchor)) anchor = base = x;
      if (left-- <= 0) {
        if (mode === 'squeeze') {
          mode = 'dump';
          left = ticksIn(rng, m.dumpSec, dt);
          perTick = (base + between(rng, m.dumpTo) - anchor) / left;
        } else if (mode === 'calm' && rng.float() < m.squeezeChance) {
          mode = 'squeeze';
          left = ticksIn(rng, m.squeezeSec, dt);
          perTick = between(rng, m.squeezeGain) / left;
        } else {
          mode = 'calm';
          left = ticksIn(rng, m.calmSec, dt);
          perTick = 0;
        }
      }
      anchor += perTick + (mode === 'calm' ? calmNoise * gauss(rng) : 0);
      dev += -m.revert * dev * dt + noise * gauss(rng);
      if (rng.float() < m.jumpRate * dt) dev += (rng.float() < m.jumpUp ? 1 : -1) * between(rng, m.jumpSize);
      return anchor + dev - x;
    },
    shift(d) {
      base += d;
      anchor += d;
    },
  };
}
