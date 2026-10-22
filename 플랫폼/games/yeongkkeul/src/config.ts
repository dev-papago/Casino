// Every tunable number lives here; the app and scripts/simulate.ts read the same object.
// Model rates are per second of game time (log returns, hazards in events per second);
// the market converts them to one tick (timing.tickMs). Ranges are inclusive [min, max].
export type Range = readonly [number, number];

/**
 * 거래량. A busier stock quotes more often and fills later: a quiet one shows a new price
 * every few seconds and fills at the shown price; a frantic one moves faster than the eye and fills a moment
 * after the click at whatever the price is by then.
 */
export interface VolumeDef {
  level: VolumeLevel;
  quoteSec: number; // average time between quote changes (at most one per tick)
  fillDelay: Range; // seconds from the click to the fill (0: at the shown price)
  chartPad: number; // the chart shows this many times the visible price range: larger → shorter candles on screen
  // The chart's price range is at least ±this share of the price, so the first few candles of a game (a narrow
  // range of their own) do not fill the screen: a quiet stock's opening candles look short, a busy one's tall.
  startSpan: number;
}

/**
 * Randomness every stock gets: Gaussian noise whose size wanders between calm and choppy stretches, plus rare
 * jumps either way, so the next candles cannot be read off the last ones. Busy stocks also get needles: a fast
 * mean-reverting deviation that spikes and snaps back within a few tenths of a second. None of it moves the
 * expected price.
 */
export interface NoiseDef {
  vol: number; // per √second, on average
  wander: number; // spread of the log volatility (0: always the same size)
  wanderSec: number; // typical length of a calm or choppy stretch
  jumpRate: number; // jumps per second
  jumpSize: Range; // log size of a jump; up or down with equal odds
  needle?: { vol: number; revert: number; rate: number; size: Range }; // revert 15/s → half-life about 0.05 s
}

/** 돌지코인's swings: sum of sine waves (new period and height every half wave) around a slowly wandering anchor. */
export interface WaveDef {
  waves: readonly { periodSec: Range; amp: Range }[];
  revert: number; // pull toward the anchor, per second
  anchorVol: number;
}

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
 * random moment of that window, so one at 1:50 can be followed by another just after 2:00. Until the window's
 * event comes, the price drifts the other way by the event's expected effect: this drift is the stock's
 * tendency (a stock that can crash creeps up, one that can spike slides down), and the expected price stays put.
 */
export interface EventDef {
  chance: number; // probability that a window has an event
  up: number; // probability the event is a spike (else a crash)
  gain: Range; // log size of a spike
  drop: Range; // log size of a crash
  sec: Range; // how long the move takes: faster than a click
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
  wave?: WaveDef;
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
  chipValue: number; // dollars per booth chip when the game pays out (the same chips as 야바위)
  // 배당금 (casino mode, the 승리 추세): this share of the margin in open positions a minute is added to
  // the cash for a guest with no chips at all, less the more they have (chips in all), none from dividendUntil chips
  // on. Nothing held, nothing earned.
  dividendPerMin: number;
  dividendUntil: number;
}

export interface GameConfig {
  timing: {
    tickMs: number;
    ticksPerCandle: number;
    historyCandles: number; // drawn before the game starts, ending at the start price (0: the chart starts empty)
    visibleCandles: number; // candles on screen at first; dragging the chart sideways changes it within zoomCandles
    zoomCandles: Range;
    keepCandles: number;
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
    eventWindowSec: 120,
  },
  economy: {
    deposit: 1000,
    leverages: [1, 2, 5, 10],
    feeRate: 0.001,
    maintenance: 0.2,
    minOrder: 10,
    leverageFrom: 2000,
    chipValue: 1000, // $1,000 = 1 chip
    // 승리 추세 (casino), tuned with the 확률 시뮬레이터 (플랫폼 /sim) for a bold guest: about 1% end broke, most with
    // 5–19 chips, about 3.5% reach 50; 12.3 chips on average (a skill game).
    dividendPerMin: 0.22,
    dividendUntil: 20,
  },
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
      volume: { level: 1, quoteSec: 2, fillDelay: [0, 0], chartPad: 2.6, startSpan: 0.03 },
      noise: { vol: 0.001, wander: 0.3, wanderSec: 20, jumpRate: 0.01, jumpSize: [0.003, 0.008] },
      patterns: { amp: 0.008, sec: [45, 90], gapSec: [10, 30], bubble: 0, bubbleSec: [150, 240], bubbleAmp: 0 },
      events: { chance: 0.15, up: 0, gain: [0, 0], drop: [0.06, 0.1], sec: [0.1, 0.4] },
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
      volume: { level: 3, quoteSec: 0.6, fillDelay: [0.2, 0.5], chartPad: 1.5, startSpan: 0.012 },
      noise: { vol: 0.003, wander: 0.35, wanderSec: 15, jumpRate: 0.02, jumpSize: [0.005, 0.015] },
      patterns: { amp: 0.02, sec: [40, 90], gapSec: [10, 30], bubble: 0.05, bubbleSec: [150, 240], bubbleAmp: 0.12 },
      events: { chance: 0.07, up: 0, gain: [0, 0], drop: [0.28, 0.38], sec: [0.1, 0.4] },
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
      volume: { level: 4, quoteSec: 0.3, fillDelay: [0.3, 0.7], chartPad: 1.2, startSpan: 0.008 },
      wave: {
        waves: [
          { periodSec: [40, 90], amp: [0.0006, 0.0015] },
          { periodSec: [8, 16], amp: [0.0004, 0.001] },
        ],
        revert: 0.003,
        anchorVol: 0.003,
      },
      noise: { vol: 0.008, wander: 0.35, wanderSec: 15, jumpRate: 0.03, jumpSize: [0.01, 0.025] },
      patterns: { amp: 0.045, sec: [40, 100], gapSec: [5, 25], bubble: 0.1, bubbleSec: [150, 240], bubbleAmp: 0.15 },
      events: { chance: 0.45, up: 0.5, gain: [0.05, 0.1], drop: [0.05, 0.1], sec: [0.1, 0.4] },
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
      volume: { level: 2, quoteSec: 1, fillDelay: [0.1, 0.3], chartPad: 2, startSpan: 0.02 },
      noise: { vol: 0.004, wander: 0.35, wanderSec: 15, jumpRate: 0.03, jumpSize: [0.006, 0.02] },
      patterns: { amp: 0.022, sec: [40, 90], gapSec: [10, 30], bubble: 0, bubbleSec: [150, 240], bubbleAmp: 0 },
      events: { chance: 0.15, up: 1, gain: [0.2, 0.45], drop: [0, 0], sec: [0.1, 0.4] },
    },
    {
      id: 'gamestop',
      name: '게이임스탑',
      ticker: 'GGME',
      start: 10,
      decimals: 2,
      difficulty: 5,
      description: '대형 헤지펀드 공매도 세력과 개미들의 피비린내 나는 전투 현장. 미쳐버린 저세상 차트를 보여준다',
      bounds: [0.03, 30],
      volume: { level: 5, quoteSec: 0.1, fillDelay: [0.4, 1], chartPad: 1.12, startSpan: 0.005 },
      noise: {
        vol: 0.02,
        wander: 0.5,
        wanderSec: 10,
        jumpRate: 0.02,
        jumpSize: [0.05, 0.12],
        needle: { vol: 0.12, revert: 15, rate: 0.8, size: [0.03, 0.1] },
      },
      patterns: { amp: 0.06, sec: [30, 80], gapSec: [5, 20], bubble: 0.05, bubbleSec: [120, 200], bubbleAmp: 0.4 },
      events: { chance: 0.6, up: 0.5, gain: [0.2, 0.45], drop: [0.25, 0.55], sec: [0.1, 0.4] },
    },
  ],
};
