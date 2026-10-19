// Every tunable number lives here; the app and scripts/simulate.ts read the same object.
// Model rates are per second of game time (log returns, hazards in events per second);
// the market converts them to one tick (timing.tickMs). Ranges are inclusive [min, max].
export type Range = readonly [number, number];

/** 킹카콜라: alternating up / down regimes, low noise. */
export interface SteadyModel {
  kind: 'steady';
  vol: number;
  up: { drift: number; meanSec: number };
  down: { drift: number; meanSec: number };
}
/** SK로우닉스: steady climb; the crash hazard grows with the rally since the last bottom. */
export interface CrashModel {
  kind: 'crash';
  drift: number;
  vol: number;
  rallyFree: number; // log gain from the bottom before the hazard starts to grow
  hazardBase: number;
  hazardSlope: number; // extra crashes per second per unit of log gain above rallyFree
  crashDrop: Range; // total log drop of one crash
  crashSec: Range;
}
/** 돌지코인: sum of sine waves (new period and height every half wave) around a slowly wandering anchor. */
export interface WaveModel {
  kind: 'wave';
  vol: number;
  waves: readonly { periodSec: Range; amp: Range }[];
  revert: number; // pull toward the anchor, per second
  anchorVol: number;
}
/** 뭐더나: steady decline; rare spikes that partly fade afterwards. */
export interface DecayModel {
  kind: 'decay';
  drift: number;
  vol: number;
  spikeRate: number;
  spikeGain: Range; // total log gain of one spike
  spikeSec: Range;
  fadeShare: Range; // part of the spike given back afterwards
  fadeSec: Range;
}
/** 게이임스탑: price = anchor + fast mean-reverting deviation with jumps; the anchor squeezes and dumps. */
export interface SqueezeModel {
  kind: 'squeeze';
  revert: number; // deviation pull back, per second (3 → half-life about 0.23 s)
  vol: number;
  jumpRate: number;
  jumpSize: Range;
  jumpUp: number; // probability a jump goes up
  calmSec: Range;
  calmVol: number;
  squeezeChance: number; // after a calm stretch: squeeze with this probability, else another calm stretch
  squeezeGain: Range; // log
  squeezeSec: Range;
  dumpTo: Range; // log level relative to the base the dump falls back to
  dumpSec: Range;
}
export type ModelDef = SteadyModel | CrashModel | WaveModel | DecayModel | SqueezeModel;

export interface StockDef {
  id: string;
  name: string;
  ticker: string;
  start: number; // price when a game starts ($)
  decimals: number;
  risk: 1 | 2 | 3 | 4 | 5;
  description: string;
  bounds: Range; // soft price range as multiples of start; outside it the price is pulled back
  model: ModelDef;
}

export interface EconomyConfig {
  deposit: number; // 기본예탁금 ($)
  leverages: readonly number[];
  feeRate: number; // on position size (margin × leverage), when opening and when closing
  maintenance: number; // liquidated once the loss reaches (1 − maintenance) of the margin
  minOrder: number; // smallest margin per order ($); below this with no position the game is over
}

export interface GameConfig {
  timing: {
    tickMs: number;
    ticksPerCandle: number;
    historyCandles: number; // drawn before the game starts, ending at the start price
    visibleCandles: number;
    keepCandles: number;
  };
  economy: EconomyConfig;
  stocks: readonly StockDef[];
}

export const CONFIG: GameConfig = {
  timing: { tickMs: 100, ticksPerCandle: 10, historyCandles: 150, visibleCandles: 90, keepCandles: 600 },
  economy: { deposit: 1000, leverages: [1, 2, 5, 10, 20], feeRate: 0.001, maintenance: 0.05, minOrder: 10 },
  stocks: [
    {
      id: 'kingka',
      name: '킹카콜라',
      ticker: 'KKCL',
      start: 64,
      decimals: 2,
      risk: 1,
      description: '세계적인 필수소비재주. 장기적으로 우상향 하지만 조금 작은 확률로 우하향 한다. 가장 안전한 종목',
      bounds: [0.5, 3],
      model: {
        kind: 'steady',
        vol: 0.0012,
        up: { drift: 0.00035, meanSec: 30 },
        down: { drift: -0.0005, meanSec: 12 },
      },
    },
    {
      id: 'lownix',
      name: 'SK로우닉스',
      ticker: 'SKLW',
      start: 140,
      decimals: 2,
      risk: 3,
      description: '최근 수요가 폭증하고 있는 HBM의 선두주자. 가파르게 우상향 하지만 적은 확률로 단기간에 하락 가능',
      bounds: [0.4, 5],
      model: {
        kind: 'crash',
        drift: 0.0018,
        vol: 0.0028,
        rallyFree: 0.04,
        hazardBase: 0.001,
        hazardSlope: 0.25,
        crashDrop: [0.09, 0.16],
        crashSec: [1.5, 3.5],
      },
    },
    {
      id: 'dolge',
      name: '돌지코인',
      ticker: 'DOLGE',
      start: 2,
      decimals: 4,
      risk: 4,
      description: '최근 자금 유입이 높아진 크립토. 변동성이 큰 자산이므로 투자에 주의하자.',
      bounds: [0.35, 3],
      model: {
        kind: 'wave',
        vol: 0.004,
        waves: [
          { periodSec: [24, 48], amp: [0.006, 0.013] },
          { periodSec: [5, 11], amp: [0.003, 0.007] },
        ],
        revert: 0.004,
        anchorVol: 0.002,
      },
    },
    {
      id: 'mwodna',
      name: '뭐더나',
      ticker: 'MWDN',
      start: 61,
      decimals: 2,
      risk: 3,
      description: '암 백신 치료제를 개발하는 바이오주. 장기적으로 우하향 하지만 적은 확률로 급등 가능',
      bounds: [0.15, 3],
      model: {
        kind: 'decay',
        drift: -0.0008,
        vol: 0.0016,
        spikeRate: 0.003,
        spikeGain: [0.15, 0.35],
        spikeSec: [2, 5],
        fadeShare: [0.4, 0.7],
        fadeSec: [15, 35],
      },
    },
    {
      id: 'gamestop',
      name: '게이임스탑',
      ticker: 'GGME',
      start: 10,
      decimals: 2,
      risk: 5,
      description: '대형 헤지펀드 공매도 세력과 개미들의 피비린내 나는 전투 현장. 미쳐버린 저세상 차트를 보여준다',
      bounds: [0.2, 30],
      model: {
        kind: 'squeeze',
        revert: 3,
        vol: 0.22,
        jumpRate: 0.8,
        jumpSize: [0.05, 0.2],
        jumpUp: 0.55,
        calmSec: [8, 20],
        calmVol: 0.02,
        squeezeChance: 0.4,
        squeezeGain: [0.4, 1.1],
        squeezeSec: [6, 14],
        dumpTo: [-0.3, 0.2],
        dumpSec: [4, 10],
      },
    },
  ],
};
