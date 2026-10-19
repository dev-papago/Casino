#!/usr/bin/env node
// 야바위 booth simulation. Plain Node (>= 18) ESM, no dependencies.
// Reads the SAME defaults the app uses: src/config/defaults.json
//
//   npm run sim   (= node scripts/simulate.mjs)   full run, about 6 s
//   node scripts/simulate.mjs --quick              smoke run
//   node scripts/simulate.mjs --seed 7 --config my.json
//
// A: shuffle hit rates per level, B: expected chips per round, C: whole sessions (Monte Carlo).
// The sim uses a seeded PRNG so results are reproducible; the app uses crypto.getRandomValues.

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
const N_SESSIONS = QUICK ? 20000 : 200000; // simulated sessions per (level, policy)
const SESSION_ROUNDS = 10; // rounds a simulated player plays before pressing 정산

// Sim-only assumptions (not game config). Listed in DESIGN.md section 10.
const ASSUME = {
  // Human tracker: follows ONE hypothesis and loses it with prob es (pair swap) / er (3-cup rotation).
  // At an overlap nobody has information, so every model guesses 50:50 there.
  humans: {
    easy: { 캐주얼: [0.02, 0.02], 숙련: [0.005, 0.005], 완벽지각: [0, 0] },
    normal: { 캐주얼: [0.04, 0.04], 숙련: [0.01, 0.01], 완벽지각: [0, 0] },
    high: { 캐주얼: [0.06, 0.12], 숙련: [0.02, 0.04], 완벽지각: [0, 0] },
    hardest: { 캐주얼: [0.1, 0.2], 숙련: [0.03, 0.06], 완벽지각: [0, 0] },
  },
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

// ---------------------------------------------------------------- B. paid rounds (mirrors src/game/session.ts)
// Bet B chips on a level with multiplier m: a hit wins floor(B·m), a miss loses floor(B·m).
// Expected chips per round = floor(B·m) · (2p − 1), so a level favors the booth exactly when p < 1/2.
// B is at most economy.maxBet and never more than the stack can lose.
const amount = (bet, m) => Math.floor(bet * m + 1e-9);
function maxBet(stack, m) {
  let b = 0;
  while (b < ECON.maxBet && amount(b + 1, m) <= stack) b++;
  return b;
}

// One player: starts with buyIn, plays SESSION_ROUNDS rounds (fewer if they cannot bet), then 정산.
function mcSessions(m, p, policy) {
  const nets = [];
  let broke = 0;
  for (let i = 0; i < N_SESSIONS; i++) {
    let stack = ECON.buyIn;
    for (let r = 0; r < SESSION_ROUNDS; r++) {
      const mb = maxBet(stack, m);
      if (mb < 1) break;
      const bet = policy === 'all-in' ? mb : 1;
      stack += (rng() < p ? 1 : -1) * amount(bet, m);
    }
    if (stack === 0) broke++;
    nets.push(stack - ECON.buyIn);
  }
  nets.sort((a, b) => a - b);
  return { mean: nets.reduce((s, x) => s + x, 0) / nets.length, p5: quant(nets, 0.05), p50: quant(nets, 0.5), p95: quant(nets, 0.95), max: nets[nets.length - 1], broke: broke / N_SESSIONS };
}

// ---------------------------------------------------------------- output helpers
const pct = (x, d = 1) => (100 * x).toFixed(d) + '%';
const f = (x, d = 2) => Number(x).toFixed(d);
const sg = (x) => (x > 0 ? '+' + x : String(x).replace('-', '−'));
const sgf = (x, d = 2) => { const v = Number(x); const s = v.toFixed(d); if (Number(s) === 0) return (0).toFixed(d); return v > 0 ? '+' + s : s.replace('-', '−'); };
const table = (head, rows) => ['| ' + head.join(' | ') + ' |', '|' + head.map(() => '---').join('|') + '|', ...rows.map((r) => '| ' + r.join(' | ') + ' |')].join('\n');
function quant(sorted, x) { return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(x * (sorted.length - 1))))]; }
const n0 = (x) => Math.round(x).toLocaleString('en-US');

// ---------------------------------------------------------------- compute + print
const A = partA();
const paid = Object.entries(CFG.levels).filter(([, lv]) => lv.paid);

console.log(`## A. 난이도별 셔플과 적중률 (seed ${SEED}${QUICK ? ', quick' : ''}, 난이도마다 ${n0(N_ROUNDS)}판)\n`);
console.log(table(
  ['난이도', '배율', '동작 수', '겹치기 / 회전', '셔플 시간', '이상적 관찰자 (평균 / 최대)', '완벽 지각', '숙련', '캐주얼', '무작위'],
  Object.entries(A).map(([id, r]) => [r.label, CFG.levels[id].paid ? `×${CFG.levels[id].multiplier}` : '무료', f(r.meanMoves, 1), `${f(r.meanOverlaps, 1)} / ${f(r.meanRotations, 1)}`, f(r.shuffleSec, 1) + 's',
    `${f(r.ideal, 4)} / ${f(r.maxCeiling, 4)}`, f(r.human['완벽지각'], 4), f(r.human['숙련'], 4), f(r.human['캐주얼'], 4), f(r.random, 4)]),
));
console.log('\n이상적 관찰자 = 매 판 사후확률이 가장 큰 칸을 고르는 완벽한 관찰자. 적중률이 0.5보다 낮으면 그 난이도는 부스에 유리하다.\n');

console.log(`## B. 한 판 기대값 (판돈 1칩 / 5칩, 손님 기준 칩)\n`);
console.log(table(
  ['난이도', '배율', '판돈 1 → ±', '판돈 5 → ±', '기대값 p=1/3', '기대값 캐주얼', '기대값 완벽 지각', '기대값 이상적 관찰자'],
  paid.map(([id, lv]) => {
    const r = A[id];
    const ev = (p) => `${sgf(amount(1, lv.multiplier) * (2 * p - 1))} / ${sgf(amount(5, lv.multiplier) * (2 * p - 1))}`;
    return [lv.label, `×${lv.multiplier}`, amount(1, lv.multiplier), amount(5, lv.multiplier), ev(1 / 3), ev(r.human['캐주얼']), ev(r.human['완벽지각']), ev(r.ideal)];
  }),
));

console.log(`\n## C. 세션 (시작 ${ECON.buyIn}칩, 최대 판돈 ${ECON.maxBet}, ${SESSION_ROUNDS}판 하고 정산, 숙련 적중률, ${n0(N_SESSIONS)}세션)\n`);
const rows = [];
for (const [id, lv] of paid) {
  for (const policy of ['1칩씩', 'all-in']) {
    const r = mcSessions(lv.multiplier, A[id].human['숙련'], policy);
    rows.push([lv.label, policy, f(A[id].human['숙련'], 3), sgf(r.mean), `${sg(r.p5)} / ${sg(r.p50)} / ${sg(r.p95)}`, sg(r.max), pct(r.broke)]);
  }
}
console.log(table(['난이도', '베팅', '적중률', '손님 평균', 'p5 / p50 / p95', '최대', '칩 0개로 끝남'], rows));
