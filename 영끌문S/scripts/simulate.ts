// npm run sim [sessions] — how each stock's chart behaves under the current CONFIG (DESIGN.md section 4).
// Every session is a fresh market (history + live ticks), exactly like a new game in the app.
// Columns: return after 3 and 10 minutes, how often it ends up, typical drawdown, the biggest
// 5-second rise and fall, and what a long held from the start at 5× / 10× does (liquidation included).
import { CONFIG } from '../src/config.ts';
import { Market } from '../src/game/market.ts';
import { seededRng } from '../src/rng.ts';

const SESSIONS = Number(process.argv[2]) || 400;
const SEED = 20261019;
const TICKS_PER_SEC = 1000 / CONFIG.timing.tickMs;
const HORIZONS = [180, 600]; // seconds
const LEVERAGES = [5, 10];
const WINDOW = 5 * TICKS_PER_SEC;

interface Acc {
  ret: number[][]; // per horizon
  maxDd: number[]; // over the first 3 minutes
  rise5: number[];
  fall5: number[];
  lev: { liq: number; ret: number[] }[];
}

const end = HORIZONS[HORIZONS.length - 1] * TICKS_PER_SEC;
const rng = seededRng(SEED);
const acc: Acc[] = CONFIG.stocks.map(() => ({
  ret: HORIZONS.map(() => []),
  maxDd: [],
  rise5: [],
  fall5: [],
  lev: LEVERAGES.map(() => ({ liq: 0, ret: [] })),
}));

for (let s = 0; s < SESSIONS; s++) {
  const m = new Market(rng);
  const paths = m.stocks.map((st) => [st.price]);
  for (let t = 1; t <= end; t++) {
    m.step();
    m.stocks.forEach((st, i) => paths[i].push(st.price));
  }
  paths.forEach((p, i) => {
    const a = acc[i];
    const p0 = p[0];
    HORIZONS.forEach((h, k) => a.ret[k].push(p[h * TICKS_PER_SEC] / p0 - 1));
    const short = p.slice(0, HORIZONS[0] * TICKS_PER_SEC + 1);
    let peak = p0;
    let dd = 0;
    let rise = 0;
    let fall = 0;
    short.forEach((v, t) => {
      peak = Math.max(peak, v);
      dd = Math.max(dd, 1 - v / peak);
      if (t >= WINDOW) {
        const r = v / short[t - WINDOW] - 1;
        rise = Math.max(rise, r);
        fall = Math.min(fall, r);
      }
    });
    a.maxDd.push(dd);
    a.rise5.push(rise);
    a.fall5.push(fall);
    LEVERAGES.forEach((L, k) => {
      const liq = p0 * (1 - (1 - CONFIG.economy.maintenance) / L);
      const hit = short.some((v) => v <= liq);
      if (hit) a.lev[k].liq++;
      a.lev[k].ret.push(hit ? -1 : L * (short[short.length - 1] / p0 - 1));
    });
  });
}

const mean = (xs: number[]): number => xs.reduce((s, x) => s + x, 0) / xs.length;
const q = (xs: number[], p: number): number => [...xs].sort((a, b) => a - b)[Math.floor(p * (xs.length - 1))];
const pct = (v: number): string => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%`;

console.log(`\n영끌문S 차트 시뮬레이션 — seed ${SEED}, ${SESSIONS} sessions, tick ${CONFIG.timing.tickMs}ms\n`);
console.log('| 종목 | 3분 평균 | 3분 p5 / p50 / p95 | 3분 상승 확률 | 10분 평균 | 10분 p5 / p95 | 3분 최대낙폭(평균) | 5초 최대 상승 / 하락(평균) |');
console.log('|---|---|---|---|---|---|---|---|');
CONFIG.stocks.forEach((st, i) => {
  const a = acc[i];
  const [r3, r10] = a.ret;
  console.log(
    `| ${st.name} | ${pct(mean(r3))} | ${pct(q(r3, 0.05))} / ${pct(q(r3, 0.5))} / ${pct(q(r3, 0.95))} | ${(mean(r3.map((r) => (r > 0 ? 1 : 0))) * 100).toFixed(0)}% | ${pct(mean(r10))} | ${pct(q(r10, 0.05))} / ${pct(q(r10, 0.95))} | ${pct(-mean(a.maxDd))} | ${pct(mean(a.rise5))} / ${pct(mean(a.fall5))} |`,
  );
});
console.log('\n| 종목 | ' + LEVERAGES.map((L) => `${L}× 3분 보유: 청산 확률 / 평균 수익`).join(' | ') + ' |');
console.log('|---|' + LEVERAGES.map(() => '---|').join(''));
CONFIG.stocks.forEach((st, i) => {
  const cells = acc[i].lev.map((l) => `${((l.liq / SESSIONS) * 100).toFixed(0)}% / ${pct(mean(l.ret))}`);
  console.log(`| ${st.name} | ${cells.join(' | ')} |`);
});
