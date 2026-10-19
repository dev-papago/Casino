#!/usr/bin/env node
// 야바위 booth simulation. Plain Node (>= 18) ESM, no dependencies.
// Reads the SAME defaults the app uses: src/config/defaults.json
//
//   npm run sim   (= node scripts/simulate.mjs)   full run, about 6 s
//   node scripts/simulate.mjs --quick              smoke run
//   node scripts/simulate.mjs --seed 7 --config my.json
//
// The output starts with "요약"; docs/DESIGN.md section 4 pastes that block verbatim.
// The sim uses a seeded PRNG so results are reproducible; the app uses crypto.getRandomValues.
// Session tables (B, C) are EXACT (dynamic programming over every reachable state).
// Shuffle (A) and festival (E) tables are Monte Carlo.

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const QUICK = argv.includes('--quick');
const SEED = Number(opt('--seed', '20261019')) >>> 0;
const CONFIG_PATH = resolve(opt('--config', join(ROOT, 'src/config/defaults.json')));
const CFG = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
const ECON = CFG.economy;

const N_ROUNDS = QUICK ? 20000 : 200000; // shuffle plans per level
const N_DAYS = QUICK ? 500 : 5000; // simulated festival days per scenario

// Sim-only assumptions (not game config). Listed in DESIGN.md section 10.
const ASSUME = {
  pickSec: 2.5, // time a player takes to pick a cup
  sessionOverheadSec: 30, // staff takes the chips, counts chips at cash-out
  // Human tracker: follows ONE hypothesis and loses it with prob es (pair swap) / er (3-cup rotation).
  // At an overlap nobody has information, so every model guesses 50:50 there.
  humans: {
    easy: { 캐주얼: [0.02, 0.02], 숙련: [0.005, 0.005], 완벽지각: [0, 0] },
    normal: { 캐주얼: [0.04, 0.04], 숙련: [0.01, 0.01], 완벽지각: [0, 0] },
    hardest: { 캐주얼: [0.1, 0.2], 숙련: [0.03, 0.06], 완벽지각: [0, 0] },
  },
  festival: { pPlay: 0.8, pReplay: 0.25, maxSessions: 3 },
};

// ---------------------------------------------------------------- RNG (sim only)
function splitmix32(seed) {
  let a = seed | 0;
  return () => {
    a = (a + 0x9e3779b9) | 0;
    let t = a ^ (a >>> 16);
    t = Math.imul(t, 0x21f0aaad); t ^= t >>> 15;
    t = Math.imul(t, 0x735a2d97); t ^= t >>> 15;
    return t >>> 0;
  };
}
function sfc32(a, b, c, d) {
  return () => {
    a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
    let t = (a + b) | 0;
    a = b ^ (b >>> 9); b = (c + (c << 3)) | 0; c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0; t = (t + d) | 0; c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
}
const sm = splitmix32(SEED);
const rng = sfc32(sm(), sm(), sm(), sm());
const randInt = (n) => Math.floor(rng() * n);

// ---------------------------------------------------------------- A. shuffle plan (mirrors src/game/shuffle.ts)
// Slots are positions 0,1,2 (left to right). Move semantics (same as the Move type in DESIGN.md section 8):
//   swap(a,b)          the cups at slots a and b trade slots (separated arcs, trackable in principle)
//   rotate(dir)        the cup at slot i moves to slot (i + dir) % 3, all three at once (trackable in principle)
//   overlap(a,b,pass)  the cups at a and b meet at ONE point, fully coincide, then leave on the same two paths.
//                      pass = true: they trade slots like swap. pass = false: each returns to its own slot.
//                      Cups are identical and z-order depends only on position, so both look identical.
// Ideal observer: swap/rotate permute the belief vector, overlap averages the pair.
// ceiling = max(belief) = best hit rate ANY observer can reach on that plan.
// Plans with ceiling > cMax are redrawn. Acceptance never looks at the coins.
const PAIRS = [[0, 1], [1, 2], [0, 2]];

function drawMoves(sh) {
  const n = sh.moves[0] + randInt(sh.moves[1] - sh.moves[0] + 1);
  const { swap, rotate, overlap } = sh.mix;
  const tot = swap + rotate + overlap;
  const moves = [];
  for (let k = 0; k < n; k++) {
    const r = rng() * tot;
    const durMs = Math.round(sh.moveMs[0] + rng() * (sh.moveMs[1] - sh.moveMs[0]));
    if (r < overlap) { const [a, b] = PAIRS[randInt(3)]; moves.push({ kind: 'overlap', a, b, durMs: Math.round(durMs * CFG.timing.overlapMsMult) }); }
    else if (r < overlap + rotate) moves.push({ kind: 'rotate', dir: rng() < 0.5 ? 1 : 2, durMs });
    else { const [a, b] = PAIRS[randInt(3)]; moves.push({ kind: 'swap', a, b, durMs }); }
  }
  return moves;
}

function belief(start, moves) {
  let p = [0, 0, 0];
  p[start] = 1;
  for (const m of moves) {
    if (m.kind === 'swap') [p[m.a], p[m.b]] = [p[m.b], p[m.a]];
    else if (m.kind === 'rotate') { const q = [0, 0, 0]; for (let i = 0; i < 3; i++) q[(i + m.dir) % 3] = p[i]; p = q; }
    else { const avg = (p[m.a] + p[m.b]) / 2; p[m.a] = avg; p[m.b] = avg; }
  }
  return p;
}

// Slot of the ball's cup after every move (the fold of applyMove in the app).
function ballSlot(start, moves) {
  let pos = start;
  for (const m of moves) {
    if (m.kind === 'swap' || (m.kind === 'overlap' && m.pass)) { if (pos === m.a) pos = m.b; else if (pos === m.b) pos = m.a; }
    else if (m.kind === 'rotate') pos = (pos + m.dir) % 3;
  }
  return pos;
}

function generatePlan(sh) {
  const start = randInt(3);
  for (let tries = 1; ; tries++) {
    const moves = drawMoves(sh);
    const post = belief(start, moves);
    const ceiling = Math.max(...post);
    if (sh.cMax == null || ceiling <= sh.cMax + 1e-12) {
      for (const m of moves) if (m.kind === 'overlap') m.pass = rng() < 0.5; // coins drawn AFTER acceptance
      return { start, moves, post, ceiling, final: ballSlot(start, moves), tries, ms: moves.reduce((s, m) => s + m.durMs, 0) };
    }
    if (tries > 100000) throw new Error('cMax unreachable with this shuffle config');
  }
}

function humanPick(plan, [es, er]) {
  let h = plan.start;
  for (const m of plan.moves) {
    if (m.kind === 'swap') {
      if (h === m.a || h === m.b) { const nh = h === m.a ? m.b : m.a; h = rng() < es ? (rng() < 0.5 ? h : 3 - h - nh) : nh; }
    } else if (m.kind === 'rotate') {
      const nh = (h + m.dir) % 3;
      h = rng() < er ? [0, 1, 2].filter((x) => x !== nh)[randInt(2)] : nh;
    } else if ((h === m.a || h === m.b) && rng() < 0.5) h = h === m.a ? m.b : m.a;
  }
  return h;
}

function partA() {
  const out = {};
  for (const [id, lv] of Object.entries(CFG.levels)) {
    const models = Object.entries(ASSUME.humans[id] || {});
    let moves = 0, overlaps = 0, rotations = 0, ms = 0, tries = 0, maxTries = 0, sumC = 0, maxC = 0, random = 0;
    const human = models.map(() => 0);
    const grid = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (let i = 0; i < N_ROUNDS; i++) {
      const r = generatePlan(lv.shuffle);
      moves += r.moves.length; ms += r.ms; tries += r.tries; maxTries = Math.max(maxTries, r.tries);
      for (const m of r.moves) { if (m.kind === 'overlap') overlaps++; else if (m.kind === 'rotate') rotations++; }
      sumC += r.ceiling; maxC = Math.max(maxC, r.ceiling);
      grid[r.start][r.final]++;
      if (randInt(3) === r.final) random++;
      models.forEach(([, e], j) => { if (humanPick(r, e) === r.final) human[j]++; });
    }
    let chi2 = 0;
    for (const row of grid) { const s = row[0] + row[1] + row[2]; for (const x of row) chi2 += (x - s / 3) ** 2 / (s / 3); }
    out[id] = {
      label: lv.label, paid: lv.paid, meanMoves: moves / N_ROUNDS, meanOverlaps: overlaps / N_ROUNDS, meanRotations: rotations / N_ROUNDS,
      shuffleSec: ms / N_ROUNDS / 1000, meanTries: tries / N_ROUNDS, maxTries, ideal: sumC / N_ROUNDS, maxCeiling: maxC,
      random: random / N_ROUNDS, chi2, human: Object.fromEntries(models.map(([name], j) => [name, human[j] / N_ROUNDS])),
    };
  }
  return out;
}

// ---------------------------------------------------------------- B. session rules, EXACT (mirrors src/game/session.ts)
// Staff takes buyIn chips; the fee is taken at once, so stack = buyIn - fee. After each round (= before the next) the session ENDS if
//   net >= winCap ('clear')  |  stack < stake ('broke': game chips used up)  |  rounds used up ('rounds').
// net = stack - buyIn, so the worst result is -buyIn.
function endReason(e, stack, r) {
  if (e.winCap != null && stack - e.buyIn >= e.winCap) return 'clear';
  if (stack < e.stake) return 'broke';
  if (r >= e.maxRounds) return 'rounds';
  return null;
}

function exactSession(e, p) {
  const add = (m, k, v) => m.set(k, (m.get(k) || 0) + v);
  let cur = new Map([[e.buyIn - e.fee, 1]]);
  const dist = new Map();
  const ends = { clear: 0, broke: 0, rounds: 0 };
  let eRounds = 0;
  for (let r = 0; cur.size; r++) {
    const next = new Map();
    for (const [stack, pr] of cur) {
      const why = endReason(e, stack, r);
      if (why) { ends[why] += pr; add(dist, stack - e.buyIn, pr); continue; }
      eRounds += pr;
      add(next, stack - e.stake + e.returnOnWin, pr * p);
      add(next, stack - e.stake, pr * (1 - p));
    }
    cur = next;
  }
  const keys = [...dist.keys()].sort((a, b) => a - b).filter((k) => dist.get(k) > 1e-12);
  let mean = 0, m2 = 0;
  for (const k of keys) { mean += k * dist.get(k); m2 += k * k * dist.get(k); }
  const q = (x) => { let c = 0; for (const k of keys) { c += dist.get(k); if (c >= x - 1e-12) return k; } return keys.at(-1); };
  const P = (pred) => keys.filter(pred).reduce((s, k) => s + dist.get(k), 0);
  const paidIn = eRounds * e.stake + e.fee;
  return {
    p, mean, sd: Math.sqrt(Math.max(0, m2 - mean * mean)), p5: q(0.05), p50: q(0.5), p95: q(0.95), min: keys[0], max: keys.at(-1),
    pEven: P((k) => k >= 0), pGain5: P((k) => k >= 5), ends, eRounds,
    rtp: (paidIn + mean) / paidIn, dist: Object.fromEntries(keys.map((k) => [k, dist.get(k)])),
  };
}

function breakEven(e) {
  let lo = 0.2, hi = 0.8;
  for (let i = 0; i < 50; i++) { const mid = (lo + hi) / 2; if (exactSession(e, mid).mean < 0) lo = mid; else hi = mid; }
  return (lo + hi) / 2;
}

function mcSession(e, p) {
  let stack = e.buyIn - e.fee, r = 0;
  while (!endReason(e, stack, r)) { stack -= e.stake; if (rng() < p) stack += e.returnOnWin; r++; }
  return stack - e.buyIn;
}

// ---------------------------------------------------------------- E. festival day (booth budget), Monte Carlo
function festivalDay(scn) {
  const V = CFG.booth.expectedVisitors, C = CFG.booth.chipsPerVisitor;
  let outstanding = 0, sessions = 0;
  for (let v = 0; v < V; v++) {
    let chips = C;
    if (rng() < scn.pPlay) {
      const p = scn.skill[randInt(scn.skill.length)];
      for (let s = 0; s < scn.maxSessions; s++) {
        if (s > 0 && rng() >= scn.pReplay) break;
        if (chips < ECON.buyIn) break;
        chips += mcSession(ECON, p);
        sessions++;
      }
    }
    outstanding += chips;
  }
  return { issued: V * C, outstanding, booth: V * C - outstanding, sessions };
}

// ---------------------------------------------------------------- output helpers
const MINUS = '−';
const pct = (x, d = 1) => (100 * x).toFixed(d) + '%';
const f = (x, d = 2) => Number(x).toFixed(d);
const sg = (x) => (x > 0 ? '+' + x : String(x).replace('-', MINUS));
const sgf = (x, d = 2) => { const v = Number(x); const s = v.toFixed(d); if (Number(s) === 0) return (0).toFixed(d); return v > 0 ? '+' + s : s.replace('-', MINUS); };
const table = (head, rows) => ['| ' + head.join(' | ') + ' |', '|' + head.map(() => '---').join('|') + '|', ...rows.map((r) => '| ' + r.join(' | ') + ' |')].join('\n');
const quant = (sorted, x) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(x * (sorted.length - 1))))];
const n0 = (x) => Math.round(x).toLocaleString('en-US');

// ---------------------------------------------------------------- compute
const t0 = Date.now();
const A = partA();
const H = A.hardest;
const cMax = CFG.levels.hardest.shuffle.cMax ?? H.maxCeiling;
const be = breakEven(ECON);
const S = exactSession(ECON, 1 / 3);
const SI = exactSession(ECON, H.ideal);
const SC = exactSession(ECON, cMax);
const ECON6 = { ...ECON, maxRounds: 6 };
const S6 = exactSession(ECON6, 1 / 3);
const [rLo, rHi] = ECON.maxRoundsRange;
const worstInRange = Math.max(...Array.from({ length: rHi - rLo + 1 }, (_, i) => exactSession({ ...ECON, maxRounds: rLo + i }, cMax).mean));

const real = [1 / 3, H.human['캐주얼'], H.human['숙련'], H.human['완벽지각']];
const scenarios = [
  [`현실적: ${pct(ASSUME.festival.pPlay, 0)} 플레이, ${pct(ASSUME.festival.pReplay, 0)} 재도전(최대 ${ASSUME.festival.maxSessions}세션)`, { ...ASSUME.festival, skill: real }],
  ['최악(정상 셔플): 전원 이상적 관찰자, 전원 3세션', { pPlay: 1, pReplay: 1, maxSessions: 3, skill: [H.ideal] }],
  ['버그 가정: 셔플 화면이 새서 전원 p = 0.40, 3세션', { pPlay: 1, pReplay: 1, maxSessions: 3, skill: [0.4] }],
];
const E = scenarios.map(([name, scn]) => {
  const nets = []; let over = 0, sessions = 0;
  for (let d = 0; d < N_DAYS; d++) { const r = festivalDay(scn); nets.push(r.booth); if (r.outstanding > r.issued) over++; sessions += r.sessions; }
  nets.sort((a, b) => a - b);
  return { name, mean: nets.reduce((a, b) => a + b, 0) / N_DAYS, p1: quant(nets, 0.01), worst: nets[0], over: over / N_DAYS, sessions: sessions / N_DAYS };
});

const T = CFG.timing;
const roundSec = (T.showBallMs + H.shuffleSec * 1000 + T.revealMs + T.resultMs) / 1000 + ASSUME.pickSec;
const sessionSec = ASSUME.sessionOverheadSec + S.eRounds * roundSec;
const session6Sec = ASSUME.sessionOverheadSec + S6.eRounds * roundSec;

// ---------------------------------------------------------------- summary (pasted verbatim into DESIGN.md section 4)
const issued = CFG.booth.expectedVisitors * CFG.booth.chipsPerVisitor;
const lvLine = (id) => { const r = A[id]; return `  - ${r.label}: ${f(r.human['캐주얼'], 3)} / ${f(r.human['숙련'], 3)} / ${f(r.human['완벽지각'], 3)} / ${f(r.ideal, 3)}, 셔플 ${f(r.shuffleSec, 1)}초`; };
console.log(`## 요약 (seed ${SEED}${QUICK ? ', quick' : ''}, config ${CONFIG_PATH.replace(ROOT + '/', '')})\n`);
console.log([
  `- 최상 규칙: 칩 ${ECON.buyIn}개를 받는다 (참가비 ${ECON.fee} + 게임 칩 ${ECON.buyIn - ECON.fee}). 한 판 ${ECON.stake}칩, 맞히면 ${ECON.returnOnWin}칩. 최대 ${ECON.maxRounds}판. 게임 칩이 0개가 되거나 +${ECON.winCap}칩 이상 따면 끝.`,
  `- 적중률 1/3 (사람 대부분): 세션 평균 ${sgf(S.mean)}칩, 세션 RTP ${pct(S.rtp)} (한 판 RTP ${pct((ECON.returnOnWin / 3) / ECON.stake)}). 결과 ${sg(S.min)} … ${sg(S.max)}, p5 / p50 / p95 = ${sg(S.p5)} / ${sg(S.p50)} / ${sg(S.p95)}, 평균 ${f(S.eRounds, 1)}판.`,
  `- 같은 조건에서 ${ECON.buyIn}칩을 모두 잃는 세션 ${pct(S.ends.broke)}, 본전 이상 ${pct(S.pEven)}, +5칩 이상 ${pct(S.pGain5)}, 클리어 ${pct(S.ends.clear)}.`,
  `- 최대 판수를 6으로 줄이면: 평균 ${sgf(S6.mean)}칩, 세션 RTP ${pct(S6.rtp)}, ${ECON.buyIn}칩을 모두 잃는 세션 ${pct(S6.ends.broke)}, 결과 ${sg(S6.min)} … ${sg(S6.max)}, 평균 ${f(S6.eRounds, 1)}판.`,
  `- 이상적 관찰자 (모든 프레임을 슬로모션으로 보는 완벽한 관찰자): 최상 적중률 평균 ${f(H.ideal, 4)} → 세션 평균 ${sgf(SI.mean)}칩. 어떤 판도 cMax = ${f(cMax, 4)}보다 높지 않다. 세션 손익분기 적중률은 ${f(be, 4)}.`,
  `- 매 판 ${f(cMax, 4)}로 쳐도 세션 평균 ${sgf(SC.mean)}칩이고, 관리자가 고를 수 있는 최대 판수 ${rLo}~${rHi} 어디서나 ${sgf(worstInRange)}칩 이하다.`,
  `- 난이도별 적중률 (캐주얼 / 숙련 / 완벽 지각 / 이상적 관찰자)과 셔플 길이`,
  lvLine('easy'), lvLine('normal'), lvLine('hardest'),
  `- 쉬움·보통에 1칩 걸고 2칩을 주면 완벽 지각만으로 RTP ${pct(2 * A.easy.human['완벽지각'], 0)} / ${pct(2 * A.normal.human['완벽지각'], 0)} → 부스가 진다. 그래서 무료 연습판이다.`,
  `- 축제 하루 (${CFG.booth.expectedVisitors}명 × ${CFG.booth.chipsPerVisitor}칩 = ${n0(issued)}칩 발행, ${n0(N_DAYS)}일): 현실적 시나리오에서 부스 평균 ${sgf(E[0].mean, 0)}칩, 나쁜 날(p1) ${sg(E[0].p1)}칩, 가장 나쁜 날 ${sg(E[0].worst)}칩. 상품 예산(발행 칩)을 넘은 날 ${pct(E[0].over, 2)}. 전원 이상적 관찰자로 3세션씩 해도 평균 ${sgf(E[1].mean, 0)}칩, 넘은 날 ${pct(E[1].over, 2)}. 렌더링 버그로 전원 p = 0.40이면 평균 ${sgf(E[2].mean, 0)}칩.`,
  `- 처리량: 한 판 ${f(roundSec, 1)}초, 세션 ${f(sessionSec / 60, 1)}분 → 시간당 약 ${f(3600 / sessionSec, 0)}세션 (최대 6판이면 약 ${f(3600 / session6Sec, 0)}세션).`,
].join('\n'));
console.log('\n전체 표는 아래.\n');

// ---------------------------------------------------------------- full tables
console.log(`## A. 난이도별 셔플과 적중률 (난이도마다 ${n0(N_ROUNDS)}판, Monte Carlo)\n`);
console.log(table(
  ['난이도', '칩', '동작 수', '겹치기 / 회전', '셔플 시간', '이상적 관찰자 (평균 / 최대)', '완벽 지각', '숙련', '캐주얼', '무작위', 'χ² (최종 vs 시작)'],
  Object.values(A).map((r) => [r.label, r.paid ? '유료' : '무료', f(r.meanMoves, 1), `${f(r.meanOverlaps, 1)} / ${f(r.meanRotations, 1)}`, f(r.shuffleSec, 1) + 's',
    `${f(r.ideal, 4)} / ${f(r.maxCeiling, 4)}`, f(r.human['완벽지각'], 4), f(r.human['숙련'], 4), f(r.human['캐주얼'], 4), f(r.random, 4), f(r.chi2, 1)]),
));
console.log(`\n이상적 관찰자 = 매 판 사후확률이 가장 큰 칸을 고르는 완벽한 관찰자 (평균 = 기대 적중률, 최대 = 한 판 상한). χ²(자유도 6) 99% 임계값 16.81. 최상 생성 시도 평균 ${f(H.meanTries, 1)}회, 최대 ${H.maxTries}회.\n`);

const grid = [
  [0.3, '0.30 (못 따라감)'],
  [1 / 3, '1/3 (사람 대부분)'],
  [H.ideal, `${f(H.ideal, 4)} (이상적 관찰자 평균)`],
  [cMax, `${f(cMax, 5)} (한 판 상한 cMax)`],
  [be, `${f(be, 4)} (세션 손익분기)`],
  [0.4, '0.40 (버그 가정)'],
];
console.log(`## B. 최상: 칩 ${ECON.buyIn}개 (참가비 ${ECON.fee}), ${ECON.stake}칩 걸고 맞히면 ${ECON.returnOnWin}칩, 최대 ${ECON.maxRounds}판, 클리어 +${ECON.winCap} (정확 계산)\n`);
console.log(table(
  ['적중률 p', '한 판 RTP', '세션 RTP', '세션 평균', '표준편차', 'p5 / p50 / p95', '최소 / 최대', `${ECON.buyIn}칩 모두 잃음`, '이익 ≥5', '본전 이상', '클리어', '평균 판수'],
  grid.map(([p, label]) => { const r = exactSession(ECON, p); return [label, pct((p * ECON.returnOnWin) / ECON.stake), pct(r.rtp), sgf(r.mean), f(r.sd), `${sg(r.p5)} / ${sg(r.p50)} / ${sg(r.p95)}`, `${sg(r.min)} / ${sg(r.max)}`,
    pct(r.ends.broke), pct(r.pGain5), pct(r.pEven), pct(r.ends.clear), f(r.eRounds, 2)]; }),
));
console.log(`\n세션 RTP = 돌려받은 칩 / (건 칩 + 참가비). p = 1/3 정확 분포: ` + Object.entries(S.dist).map(([k, v]) => [Number(k), v]).sort((a, b) => a[0] - b[0]).filter(([, v]) => v > 1e-5).map(([k, v]) => `${sg(k)}: ${pct(v, 2)}`).join(', ') + '\n');

console.log('## C. 최상 규칙 대안 (정확 계산)\n');
const V = [
  ...Array.from({ length: rHi - rLo + 1 }, (_, i) => rLo + i).map((m) => [m === ECON.maxRounds ? `**최대 ${m}판 (기본값)**` : `최대 ${m}판`, { ...ECON, maxRounds: m }]),
  ['참가비 없음', { ...ECON, fee: 0 }],
  ['클리어 없음', { ...ECON, winCap: null }],
];
console.log(table(['규칙', '세션 RTP (1/3 / 이상적)', '평균 (1/3 / 이상적 / 0.40)', '표준편차', 'p5 / p50 / p95', '최소 / 최대', `${ECON.buyIn}칩 모두 잃음`, '평균 판수', '손익분기 p'],
  V.map(([name, e]) => {
    const a = exactSession(e, 1 / 3), b = exactSession(e, H.ideal), c = exactSession(e, 0.4);
    return [name, `${pct(a.rtp)} / ${pct(b.rtp)}`, `${sgf(a.mean)} / ${sgf(b.mean)} / ${sgf(c.mean)}`, f(a.sd), `${sg(a.p5)} / ${sg(a.p50)} / ${sg(a.p95)}`, `${sg(a.min)} / ${sg(a.max)}`, pct(a.ends.broke), f(a.eRounds, 1), f(breakEven(e), 3)];
  })));
console.log('\n최대 판수와 참가비만 다른 행은 p = 1/3에서 평균이 모두 −참가비다 (한 판이 공정하므로). 판수를 늘리면 RTP는 100%에 가까워지지만 표준편차가 커지고, 칩을 모두 잃는 비율은 줄지 않는다.\n');

console.log('## D. 쉬움·보통에 칩을 걸게 하면? (참고, 1칩 걸고 2칩 받는다고 가정, RTP = 2p)\n');
console.log(table(['난이도', '캐주얼', '숙련', '완벽 지각', '이상적 관찰자'],
  ['easy', 'normal'].map((id) => [A[id].label, ...['캐주얼', '숙련', '완벽지각'].map((k) => `${f(A[id].human[k], 3)} → ${pct(2 * A[id].human[k], 0)}`), `${f(A[id].ideal, 3)} → ${pct(2 * A[id].ideal, 0)}`])));
console.log('');

console.log(`## E. 축제 하루 (방문자 ${CFG.booth.expectedVisitors}명 × ${CFG.booth.chipsPerVisitor}칩 = ${n0(issued)}칩 발행, ${n0(N_DAYS)}일 반복)\n`);
console.log(table(['시나리오', '부스 순이익 평균', 'p1', '최악', '상품 교환 칩 > 발행 칩 확률', '세션/일'],
  E.map((r) => [r.name, sgf(r.mean, 0), sg(r.p1), sg(r.worst), pct(r.over, 2), f(r.sessions, 0)])));
console.log(`\n부스 순이익 = 발행 칩 − 하루 끝에 방문자가 가진 칩(= 상품으로 바꿀 칩). 양수면 상품 예산(발행 칩 × 칩 가치) 안에서 끝난다. 칩이 ${ECON.buyIn}개 이상 남은 사람만 다시 할 수 있다.\n`);

console.log('## F. 처리량 (노트북 1대)\n');
console.log(table(['항목', '값'], [
  ['최상 한 판 (공 보여주기 + 셔플 + 선택 + 공개 + 결과)', f(roundSec, 1) + '초'],
  [`세션 (평균 ${f(S.eRounds, 1)}판 + 접수·정산 ${ASSUME.sessionOverheadSec}초)`, `${f(sessionSec / 60, 1)}분 → 시간당 약 ${f(3600 / sessionSec, 0)}세션`],
  ['최대 판수 6으로 줄이면', `${f(session6Sec / 60, 1)}분 → 시간당 약 ${f(3600 / session6Sec, 0)}세션`],
]));
console.log(`\n(실행 시간 ${((Date.now() - t0) / 1000).toFixed(1)}s)`);
