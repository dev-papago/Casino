// Every tunable number lives here; the app and scripts/simulate.ts read the same object.
// Model rates are per second of game time (log returns, hazards in events per second);
// the market converts them to one tick (timing.tickMs). Ranges are inclusive [min, max].
export type Range = readonly [number, number];

/**
 * Randomness every stock gets on top of its model (DESIGN.md section 2): Gaussian noise whose size wanders
 * between calm and choppy stretches, plus rare jumps either way. It hides the model's trend over a few
 * seconds, so the next candles cannot be read off the last ones; the trend only shows over minutes.
 */
export interface NoiseDef {
  vol: number; // per √second, on average
  wander: number; // spread of the log volatility (0: always the same size)
  wanderSec: number; // typical length of a calm or choppy stretch
  jumpRate: number; // jumps per second
  jumpSize: Range; // log size of a jump; up or down with equal odds
}

/** 킹카콜라: alternating up / down regimes. */
export interface SteadyModel {
  kind: 'steady';
  up: { drift: number; meanSec: number };
  down: { drift: number; meanSec: number };
}
/** SK로우닉스: steady climb; the crash hazard grows with the rally since the last bottom. */
export interface CrashModel {
  kind: 'crash';
  drift: number;
  rallyFree: number; // log gain from the bottom before the hazard starts to grow
  hazardBase: number;
  hazardSlope: number; // extra crashes per second per unit of log gain above rallyFree
  crashDrop: Range; // total log drop of one crash
  crashSec: Range;
}
/** 돌지코인: sum of sine waves (new period and height every half wave) around a slowly wandering anchor. */
export interface WaveModel {
  kind: 'wave';
  waves: readonly { periodSec: Range; amp: Range }[];
  revert: number; // pull toward the anchor, per second
  anchorVol: number;
}
/** 뭐더나: steady decline; rare spikes that partly fade afterwards. */
export interface DecayModel {
  kind: 'decay';
  drift: number;
  spikeRate: number;
  spikeGain: Range; // total log gain of one spike
  spikeSec: Range;
  fadeShare: Range; // part of the spike given back afterwards
  fadeSec: Range;
}
/**
 * 게이임스탑: nothing to read. The level takes sudden jumps both ways (squeezes up, crashes down) that stay, on top
 * of the noise, and a fast mean-reverting deviation adds sub-second needles. A jump says nothing about the next
 * one, so selling the top and buying the bottom is luck, not a pattern; the drift sets how fast it bleeds.
 */
export interface SqueezeModel {
  kind: 'squeeze';
  drift: number; // per second, between jumps
  squeezeRate: number; // up jumps per second
  squeezeGain: Range; // log size of an up jump
  crashRate: number; // down jumps per second
  crashDrop: Range; // log size of a down jump
  jumpSec: Range; // how long a jump takes
  revert: number; // needle pull back, per second (15 → half-life about 0.05 s: needles, not tradeable dips)
  vol: number; // needle noise
  jumpRate: number; // needle spikes per second
  jumpSize: Range;
  jumpUp: number; // probability a needle spike goes up
}
export type ModelDef = SteadyModel | CrashModel | WaveModel | DecayModel | SqueezeModel;

export type Difficulty = 1 | 2 | 3 | 4 | 5;
export const DIFFICULTY_LABEL: Record<Difficulty, string> = { 1: '쉬움', 2: '보통', 3: '어려움', 4: '고난도', 5: '극악' };

export interface StockDef {
  id: string;
  name: string;
  ticker: string;
  start: number; // price when a game starts ($)
  decimals: number;
  difficulty: Difficulty; // the tabs are sorted by this, easiest first
  description: string;
  bounds: Range; // soft price range as multiples of start; outside it the price is pulled back
  noise: NoiseDef;
  model: ModelDef;
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
    visibleCandles: number;
    keepCandles: number;
    sessionSec: number; // the market closes and everything is settled after this long (0: no limit)
  };
  economy: EconomyConfig;
  stocks: readonly StockDef[];
}

export const CONFIG: GameConfig = {
  timing: { tickMs: 100, ticksPerCandle: 10, historyCandles: 0, visibleCandles: 90, keepCandles: 600, sessionSec: 300 },
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
      noise: { vol: 0.003, wander: 0.3, wanderSec: 20, jumpRate: 0.02, jumpSize: [0.004, 0.012] },
      model: {
        kind: 'steady',
        up: { drift: 0.00022, meanSec: 45 },
        down: { drift: -0.00012, meanSec: 20 },
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
      noise: { vol: 0.0045, wander: 0.35, wanderSec: 15, jumpRate: 0.03, jumpSize: [0.006, 0.02] },
      model: {
        kind: 'crash',
        drift: 0.00055,
        rallyFree: 0.05,
        hazardBase: 0.0015,
        hazardSlope: 0.12,
        crashDrop: [0.06, 0.12],
        crashSec: [1.5, 3],
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
      noise: { vol: 0.008, wander: 0.35, wanderSec: 15, jumpRate: 0.03, jumpSize: [0.01, 0.025] },
      model: {
        kind: 'wave',
        waves: [
          { periodSec: [40, 90], amp: [0.0012, 0.003] },
          { periodSec: [8, 16], amp: [0.0008, 0.002] },
        ],
        revert: 0.003,
        anchorVol: 0.003,
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
      noise: { vol: 0.004, wander: 0.35, wanderSec: 15, jumpRate: 0.03, jumpSize: [0.006, 0.02] },
      model: {
        kind: 'decay',
        drift: -0.0004,
        spikeRate: 0.002,
        spikeGain: [0.15, 0.4],
        spikeSec: [1, 2.5],
        fadeShare: [0.5, 0.8],
        fadeSec: [15, 35],
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
      noise: { vol: 0.01, wander: 0.4, wanderSec: 10, jumpRate: 0, jumpSize: [0, 0] },
      model: {
        kind: 'squeeze',
        drift: -0.00265,
        squeezeRate: 0.018,
        squeezeGain: [0.15, 0.5],
        crashRate: 0.018,
        crashDrop: [0.15, 0.45],
        jumpSec: [0.1, 0.4],
        revert: 15,
        vol: 0.22,
        jumpRate: 0.8,
        jumpSize: [0.03, 0.1],
        jumpUp: 0.5,
      },
    },
  ],
};
