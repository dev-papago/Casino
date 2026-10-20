// Every tunable number lives here; the app and scripts/simulate.ts read the same object.
// Model rates are per second of game time (log returns, hazards in events per second);
// the market converts them to one tick (timing.tickMs). Ranges are inclusive [min, max].
export type Range = readonly [number, number];

/**
 * 거래량 (DESIGN.md section 2). A busier stock quotes more often and fills later: a quiet one shows a new price
 * every few seconds and fills at the shown price; a frantic one moves faster than the eye and fills a moment
 * after the click at whatever the price is by then.
 */
export interface VolumeDef {
  level: VolumeLevel;
  quoteSec: number; // average time between quote changes (at most one per tick)
  fillDelay: Range; // seconds from the click to the fill (0: at the shown price)
}

/**
 * Randomness every stock gets on top of its trend: Gaussian noise whose size wanders between calm and choppy
 * stretches, plus rare jumps either way. It hides the trend over a few seconds, so the next candles cannot be
 * read off the last ones; the trend only shows over minutes. Busy stocks also get needles: a fast mean-reverting
 * deviation that spikes and snaps back within a few tenths of a second.
 */
export interface NoiseDef {
  vol: number; // per √second, on average
  wander: number; // spread of the log volatility (0: always the same size)
  wanderSec: number; // typical length of a calm or choppy stretch
  jumpRate: number; // jumps per second
  jumpSize: Range; // log size of a jump; up or down with equal odds
  needle?: { vol: number; revert: number; rate: number; size: Range }; // revert 15/s → half-life about 0.05 s
}

/** 킹카콜라: alternating up / down regimes. */
export interface SteadyTrend {
  kind: 'steady';
  up: { drift: number; meanSec: number };
  down: { drift: number; meanSec: number };
}
/** 돌지코인: sum of sine waves (new period and height every half wave) around a slowly wandering anchor. */
export interface WaveTrend {
  kind: 'wave';
  waves: readonly { periodSec: Range; amp: Range }[];
  revert: number; // pull toward the anchor, per second
  anchorVol: number;
}
/** A constant drift per second. */
export interface DriftTrend {
  kind: 'drift';
  drift: number;
}
export type TrendDef = SteadyTrend | WaveTrend | DriftTrend;

/**
 * Chart formations (src/game/patterns.ts): wedges, triangles, rectangles, head and shoulders, cup and handle,
 * flags, double tops and the bubble cycle are played onto the price one after another. Each is mirrored at
 * random and breaks out in a random direction, so on average a formation moves nothing and predicts nothing.
 */
export interface PatternDef {
  amp: number; // log swing of a 60-second formation; it scales with √length
  sec: Range; // length of one formation
  gapSec: Range; // plain chart between formations
  bubble: number; // chance a formation is the bubble cycle instead
  bubbleSec: Range;
  bubbleAmp: number; // log height of the bubble's peak
}

/**
 * 급등·급락 (src/game/events.ts). Every timing.eventWindowSec seconds (2 minutes) a stock may get one event, at a
 * random moment of that window, so one at 1:50 can be followed by another just after 2:00.
 */
export interface EventDef {
  chance: number; // probability that a window has an event
  up: number; // probability the event is a spike (else a crash)
  gain: Range; // log size of a spike
  drop: Range; // log size of a crash
  sec: Range; // how long the move takes
  lead: Range; // log move the other way just before it (the "올라가는 것 같은데?" bait before a crash)
  leadSec: Range;
  giveBack: Range; // share of the move undone afterwards (0: it stays)
  giveBackSec: Range;
}

export type Difficulty = 1 | 2 | 3 | 4 | 5;
export const DIFFICULTY_LABEL: Record<Difficulty, string> = { 1: '쉬움', 2: '보통', 3: '어려움', 4: '고난도', 5: '극악' };
export type VolumeLevel = 1 | 2 | 3 | 4 | 5;
export const VOLUME_LABEL: Record<VolumeLevel, string> = { 1: '적음', 2: '보통', 3: '많음', 4: '매우 많음', 5: '폭발' };

export interface StockDef {
  id: string;
  name: string;
  ticker: string;
  start: number; // price when a game starts ($)
  decimals: number;
  difficulty: Difficulty; // the tabs are sorted by this, easiest first
  description: string;
  bounds: Range; // soft price range as multiples of start; outside it the price is pulled back
  volume: VolumeDef;
  trend: TrendDef;
  noise: NoiseDef;
  patterns: PatternDef;
  events: EventDef;
}

export interface EconomyConfig {
  deposit: number; // 기본예탁금 ($)
  leverages: readonly number[];
  feeRate: number; // on position size (margin × leverage), when opening and when closing
  maintenance: number; // leveraged positions are liquidated once the loss reaches (1 − maintenance) of the margin
  minOrder: number; // smallest margin per order ($); below this with no position the game is over
  leverageFrom: number; // leverage above 1× needs at least this much equity ($)
}

export interface GameConfig {
  timing: {
    tickMs: number;
    ticksPerCandle: number;
    historyCandles: number; // drawn before the game starts, ending at the start price (0: the chart starts empty)
    visibleCandles: number; // candles on screen at first; the mouse wheel zooms within zoomCandles
    zoomCandles: Range;
    keepCandles: number;
    sessionSec: number; // the market closes and everything is settled after this long (0: no limit)
    eventWindowSec: number; // each stock may get one 급등·급락 event per window
  };
  economy: EconomyConfig;
  stocks: readonly StockDef[];
}

export const CONFIG: GameConfig = {
  timing: {
    tickMs: 100,
    ticksPerCandle: 30, // one candle = 3 seconds
    historyCandles: 0,
    visibleCandles: 100,
    zoomCandles: [20, 300],
    keepCandles: 600,
    sessionSec: 300,
    eventWindowSec: 120,
  },
  economy: { deposit: 1000, leverages: [1, 2, 5, 10, 20], feeRate: 0.001, maintenance: 0.2, minOrder: 10, leverageFrom: 2000 },
  stocks: [
    {
      id: 'kingka',
      name: '킹카콜라',
      ticker: 'KKCL',
      start: 64,
      decimals: 2,
      difficulty: 1,
      description: '세계적인 필수소비재주. 장기적으로 우상향 하지만 조금 작은 확률로 우하향 한다. 가장 안전한 종목',
      bounds: [0.5, 3],
      volume: { level: 1, quoteSec: 2, fillDelay: [0, 0] },
      trend: { kind: 'steady', up: { drift: 0.00022, meanSec: 45 }, down: { drift: -0.00012, meanSec: 20 } },
      noise: { vol: 0.0024, wander: 0.3, wanderSec: 20, jumpRate: 0.02, jumpSize: [0.004, 0.012] },
      patterns: { amp: 0.015, sec: [45, 90], gapSec: [10, 30], bubble: 0, bubbleSec: [150, 240], bubbleAmp: 0 },
      events: {
        chance: 0.3,
        up: 0.5,
        gain: [0.015, 0.035],
        drop: [0.015, 0.035],
        sec: [1, 3],
        lead: [0, 0],
        leadSec: [0, 0],
        giveBack: [0, 0.3],
        giveBackSec: [10, 30],
      },
    },
    {
      id: 'lownix',
      name: 'SK로우닉스',
      ticker: 'SKLW',
      start: 140,
      decimals: 2,
      difficulty: 2,
      description: '최근 수요가 폭증하고 있는 HBM의 선두주자. 가파르게 우상향 하지만 적은 확률로 단기간에 하락 가능',
      bounds: [0.4, 5],
      volume: { level: 3, quoteSec: 0.6, fillDelay: [0.2, 0.5] },
      trend: { kind: 'drift', drift: 0.00048 },
      noise: { vol: 0.004, wander: 0.35, wanderSec: 15, jumpRate: 0.03, jumpSize: [0.006, 0.02] },
      patterns: { amp: 0.025, sec: [40, 90], gapSec: [10, 30], bubble: 0.05, bubbleSec: [150, 240], bubbleAmp: 0.12 },
      events: {
        chance: 0.6,
        up: 0.15,
        gain: [0.03, 0.06],
        drop: [0.08, 0.14],
        sec: [1.5, 3],
        lead: [0.015, 0.035],
        leadSec: [4, 10],
        giveBack: [0, 0.15],
        giveBackSec: [10, 30],
      },
    },
    {
      id: 'dolge',
      name: '돌지코인',
      ticker: 'DOLGE',
      start: 2,
      decimals: 4,
      difficulty: 3,
      description: '최근 자금 유입이 높아진 크립토. 변동성이 큰 자산이므로 투자에 주의하자.',
      bounds: [0.35, 3],
      volume: { level: 4, quoteSec: 0.3, fillDelay: [0.3, 0.7] },
      trend: {
        kind: 'wave',
        waves: [
          { periodSec: [40, 90], amp: [0.0006, 0.0015] },
          { periodSec: [8, 16], amp: [0.0004, 0.001] },
        ],
        revert: 0.003,
        anchorVol: 0.003,
      },
      noise: { vol: 0.008, wander: 0.35, wanderSec: 15, jumpRate: 0.03, jumpSize: [0.01, 0.025] },
      patterns: { amp: 0.045, sec: [40, 100], gapSec: [5, 25], bubble: 0.1, bubbleSec: [150, 240], bubbleAmp: 0.3 },
      events: {
        chance: 0.45,
        up: 0.5,
        gain: [0.05, 0.1],
        drop: [0.05, 0.1],
        sec: [1, 3],
        lead: [0, 0],
        leadSec: [0, 0],
        giveBack: [0.2, 0.6],
        giveBackSec: [10, 30],
      },
    },
    {
      id: 'mwodna',
      name: '뭐더나',
      ticker: 'MWDN',
      start: 61,
      decimals: 2,
      difficulty: 4,
      description: '암 백신 치료제를 개발하는 바이오주. 장기적으로 우하향 하지만 적은 확률로 급등 가능',
      bounds: [0.15, 3],
      volume: { level: 2, quoteSec: 1, fillDelay: [0.1, 0.3] },
      trend: { kind: 'drift', drift: -0.00044 },
      noise: { vol: 0.004, wander: 0.35, wanderSec: 15, jumpRate: 0.03, jumpSize: [0.006, 0.02] },
      patterns: { amp: 0.022, sec: [40, 90], gapSec: [10, 30], bubble: 0, bubbleSec: [150, 240], bubbleAmp: 0 },
      events: {
        chance: 0.25,
        up: 1,
        gain: [0.15, 0.4],
        drop: [0, 0],
        sec: [1, 2.5],
        lead: [0, 0],
        leadSec: [0, 0],
        giveBack: [0.5, 0.8],
        giveBackSec: [15, 35],
      },
    },
    {
      id: 'gamestop',
      name: '게이임스탑',
      ticker: 'GGME',
      start: 10,
      decimals: 2,
      difficulty: 5,
      description: '대형 헤지펀드 공매도 세력과 개미들의 피비린내 나는 전투 현장. 미쳐버린 저세상 차트를 보여준다',
      bounds: [0.05, 30],
      volume: { level: 5, quoteSec: 0.1, fillDelay: [0.4, 1] },
      trend: { kind: 'drift', drift: -0.0021 },
      noise: {
        vol: 0.02,
        wander: 0.5,
        wanderSec: 10,
        jumpRate: 0.02,
        jumpSize: [0.05, 0.12],
        needle: { vol: 0.22, revert: 15, rate: 0.8, size: [0.03, 0.1] },
      },
      patterns: { amp: 0.06, sec: [30, 80], gapSec: [5, 20], bubble: 0.05, bubbleSec: [120, 200], bubbleAmp: 0.4 },
      events: {
        chance: 0.9,
        up: 0.5,
        gain: [0.3, 0.8],
        drop: [0.25, 0.6],
        sec: [0.2, 0.6],
        lead: [0, 0],
        leadSec: [0, 0],
        giveBack: [0, 0],
        giveBackSec: [0, 0],
      },
    },
  ],
};
