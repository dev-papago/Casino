#!/usr/bin/env node
// 야바위 booth: consolidated simulation (shuffle ceiling + session economy + festival + guard).
// Plain Node (>= 18) ESM, no dependencies.
// It reads the SAME config file the app imports: src/config/defaults.json.
//
//   node scripts/simulate.mjs                 full run (about 1 minute)
//   node scripts/simulate.mjs --quick         fewer samples (smoke test)
//   node scripts/simulate.mjs --seed 7 --config other.json --json out.json
//
// The sim uses a seeded PRNG (sfc32) so results are reproducible.
// The app itself uses crypto.getRandomValues with rejection sampling.
// Session tables are EXACT (dynamic programming over every reachable state);
// shuffle, festival and alarm tables are Monte Carlo.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const QUICK = flag('--quick');
const SEED = Number(opt('--seed', '20261019')) >>> 0;
const CONFIG_PATH = resolve(opt('--config', join(ROOT, 'src/config/defaults.json')));
const JSON_OUT = opt('--json', null);
const CFG = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));

const N_ROUNDS = QUICK ? 30000 : 300000; // shuffle rounds per tier
const N_FEST = QUICK ? 1000 : 10000; // simulated festival days per scenario
const N_ALARM = QUICK ? 500 : 3000; // alarm trials per case
const ALARM_HORIZON = 2500; // rounds, roughly one festival day of 최상 play

// Sim-only assumptions (not game config). All of them are stated in DESIGN.md section 10.
const ASSUME = {
  pickAvgMs: 2500, // average time a player takes to pick
  sessionOverheadSec: 30, // staff enters buy-in + cash-out counting
  warmupRoundsAvg: 0.5, // free 연습/보통 rounds per session, on average
  humanModels: {
    // per-move probability of losing the cup on a plain swap / a 3-cup rotation.
    // At an overlap no information exists, so every model guesses 50:50 there.
    practice: [{ name: '캐주얼', es: 0.02, er: 0.02 }, { name: '숙련', es: 0.005, er: 0.005 }, { name: '완벽 지각', es: 0, er: 0 }],
    normal: [{ name: '캐주얼', es: 0.04, er: 0.04 }, { name: '숙련', es: 0.01, er: 0.01 }, { name: '완벽 지각', es: 0, er: 0 }],
    hardest: [{ name: '캐주얼', es: 0.1, er: 0.2 }, { name: '숙련', es: 0.03, er: 0.06 }, { name: '완벽 지각', es: 0, er: 0 }],
  },
};

// ---------------------------------------------------------------------------
// RNG (sim only)
// ---------------------------------------------------------------------------
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
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    t = (t + d) | 0;
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
}
const sm = splitmix32(SEED);
const rng = sfc32(sm(), sm(), sm(), sm());
for (let i = 0; i < 24; i++) rng();
const randInt = (n) => Math.floor(rng() * n);
const pickWeighted = (list) => { let r = rng(); for (const x of list) { if ((r -= x.w) < 0) return x; } return list[list.length - 1]; };

// ---------------------------------------------------------------------------
// PART A. Honest shuffle plan generator + ideal-observer ceiling
// (mirrors src/game/shuffle.ts generatePlan)
//   swap(a,b)    two cups trade slots on separated arcs; trackable in principle
//   rotate(dir)  all 3 cups move one slot at once; trackable in principle
//   overlap(a,b) both cups meet at ONE point, coincide, then leave along the same
//                two return paths. Hidden coin: pass (they really trade) or bounce
//                (they really return). The renderer is identity-free, so frames are
//                identical for both outcomes: zero information for any observer.
// Ideal observer: swap/rotate permute the belief vector, overlap averages the pair.
// ceiling = max(posterior) = the best hit rate ANY observer can reach on that round.
// Acceptance uses only visible structure + visible start, never the coins.
// ---------------------------------------------------------------------------
const PAIRS = [[0, 1], [1, 2], [0, 2]];

function drawMoves(sh) {
  const n = sh.moves[0] + randInt(sh.moves[1] - sh.moves[0] + 1);
  const { swap, rotate, overlap } = sh.mix;
  const tot = swap + rotate + overlap;
  const moves = [];
  for (let k = 0; k < n; k++) {
    const r = rng() * tot;
    const durMs = Math.round(sh.moveMs[0] + rng() * (sh.moveMs[1] - sh.moveMs[0]));
    if (r < overlap) { const [a, b] = PAIRS[randInt(3)]; moves.push({ kind: 'overlap', a, b, durMs: Math.round(durMs * sh.overlapMsMult) }); }
    else if (r < overlap + rotate) moves.push({ kind: 'rotate', dir: rng() < 0.5 ? 1 : 2, durMs });
    else { const [a, b] = PAIRS[randInt(3)]; moves.push({ kind: 'swap', a, b, durMs }); }
  }
  return moves;
}

function posterior(start, moves) {
  let p = [0, 0, 0];
  p[start] = 1;
  for (const m of moves) {
    if (m.kind === 'swap') { const x = p[m.a]; p[m.a] = p[m.b]; p[m.b] = x; }
    else if (m.kind === 'rotate') { const q = [0, 0, 0]; for (let i = 0; i < 3; i++) q[(i + m.dir) % 3] = p[i]; p = q; }
    else { const avg = (p[m.a] + p[m.b]) / 2; p[m.a] = avg; p[m.b] = avg; }
  }
  return p;
}

function trace(start, moves, coins) {
  let pos = start;
  moves.forEach((m, i) => {
    if (m.kind === 'swap' || (m.kind === 'overlap' && coins[i])) { if (pos === m.a) pos = m.b; else if (pos === m.b) pos = m.a; }
    else if (m.kind === 'rotate') pos = (pos + m.dir) % 3;
  });
  return pos;
}

function makeAcceptor(ceiling) {
  if (!ceiling || ceiling.mode === 'none') return () => true;
  if (ceiling.mode === 'maxPosterior') return (post) => Math.max(...post) <= ceiling.cMax + 1e-12;
  if (ceiling.mode === 'shape') {
    // the target shape for THIS round is drawn first (visible-only information)
    const shape = pickWeighted(ceiling.shapes.map((s) => ({ ...s, w: s.weight }))).shape;
    return (post) => [...post].sort((x, y) => y - x).every((v, i) => Math.abs(v - shape[i]) < 1e-9);
  }
  throw new Error('unknown ceiling mode ' + ceiling.mode);
}

function generatePlan(sh) {
  const start = randInt(3);
  const accept = makeAcceptor(sh.ceiling);
  for (let tries = 1; ; tries++) {
    const moves = drawMoves(sh);
    const post = posterior(start, moves);
    if (accept(post)) {
      const coins = moves.map((m) => (m.kind === 'overlap' ? rng() < 0.5 : false)); // drawn AFTER acceptance
      const final = trace(start, moves, coins);
      const ms = moves.reduce((s, m) => s + m.durMs, 0);
      return { start, moves, coins, post, ceiling: Math.max(...post), final, tries, ms };
    }
    if (tries > 100000) throw new Error('ceiling rule unreachable');
  }
}

// Ideal Bayesian observer (perfect eyes, slow-motion video): picks argmax posterior.
function bayesPick(plan) {
  const mx = Math.max(...plan.post);
  const best = [0, 1, 2].filter((i) => Math.abs(plan.post[i] - mx) < 1e-12);
  return best[randInt(best.length)];
}
// Human-like tracker with ONE hypothesis; loses the cup with prob es / er on plain moves.
function humanPick(plan, es, er) {
  let h = plan.start;
  for (const m of plan.moves) {
    if (m.kind === 'swap') {
      if (h === m.a || h === m.b) { const nh = h === m.a ? m.b : m.a; h = rng() < es ? (rng() < 0.5 ? h : 3 - h - nh) : nh; }
    } else if (m.kind === 'rotate') {
      const nh = (h + m.dir) % 3;
      h = rng() < er ? [0, 1, 2].filter((x) => x !== nh)[randInt(2)] : nh;
    } else if (h === m.a || h === m.b) {
      if (rng() < 0.5) h = h === m.a ? m.b : m.a;
    }
  }
  return h;
}

function partA() {
  const out = {};
  for (const [key, tier] of Object.entries(CFG.tiers)) {
    const sh = tier.shuffle;
    const models = ASSUME.humanModels[key] || [];
    let tries = 0, maxTries = 0, sumC = 0, maxC = 0, bayes = 0, rand = 0, startPick = 0, midPick = 0, moves = 0, overlaps = 0, rotations = 0, ms = 0;
    const human = models.map(() => 0);
    const fgs = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    const hist = new Map();
    for (let i = 0; i < N_ROUNDS; i++) {
      const r = generatePlan(sh);
      tries += r.tries; if (r.tries > maxTries) maxTries = r.tries;
      sumC += r.ceiling; if (r.ceiling > maxC) maxC = r.ceiling;
      const hk = r.ceiling.toFixed(4); hist.set(hk, (hist.get(hk) || 0) + 1);
      moves += r.moves.length; ms += r.ms;
      for (const m of r.moves) { if (m.kind === 'overlap') overlaps++; else if (m.kind === 'rotate') rotations++; }
      fgs[r.start][r.final]++;
      if (bayesPick(r) === r.final) bayes++;
      if (randInt(3) === r.final) rand++;
      if (r.start === r.final) startPick++;
      if (r.final === 1) midPick++;
      models.forEach((h, j) => { if (humanPick(r, h.es, h.er) === r.final) human[j]++; });
    }
    let chi2 = 0;
    for (const row of fgs) { const s = row[0] + row[1] + row[2]; for (const x of row) chi2 += (x - s / 3) ** 2 / (s / 3); }
    const top = [...hist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([c, n]) => `${c} (${pct(n / N_ROUNDS, 0)})`);
    out[key] = {
      label: tier.label, rounds: N_ROUNDS,
      meanMoves: moves / N_ROUNDS, meanOverlaps: overlaps / N_ROUNDS, meanRotations: rotations / N_ROUNDS,
      meanShuffleSec: ms / N_ROUNDS / 1000, meanTries: tries / N_ROUNDS, maxTries,
      meanCeiling: sumC / N_ROUNDS, maxCeiling: maxC, ceilingTop: top,
      bayesHit: bayes / N_ROUNDS, randomHit: rand / N_ROUNDS, startCupHit: startPick / N_ROUNDS, middleHit: midPick / N_ROUNDS,
      human: Object.fromEntries(models.map((h, j) => [h.name, human[j] / N_ROUNDS])),
      chi2FinalGivenStart: chi2,
    };
  }
  return out;
}

// ---------------------------------------------------------------------------
// PART B. Session economy, EXACT (dynamic programming over (rounds, stack)).
// Rules (mirror src/game/economy.ts):
//   * fee is charged together with the first committed round
//   * a stake is allowed only if: stack covers fee+stake,
//     net - fee - stake >= -lossLimit, and (capMode 'block') a win cannot push net above winCap
//   * capMode 'stopAfter' (used only by rejected variants): play until net >= winCap
// ---------------------------------------------------------------------------
const POLICIES = {
  playAll: ({ allowed }) => [{ bet: allowed[0], w: 1 }],
  maxBet: ({ allowed }) => [{ bet: allowed[allowed.length - 1], w: 1 }],
  randomBet: ({ allowed }) => allowed.map((b) => ({ bet: b, w: 1 / allowed.length })),
  mixed7030: ({ allowed }) => (allowed.length === 1 ? [{ bet: allowed[0], w: 1 }] : [{ bet: allowed[0], w: 0.7 }, { bet: allowed[allowed.length - 1], w: 0.3 }]),
  quitter: ({ r, net, allowed }) => (r > 0 && (net >= 4 || net <= -5) ? [{ bet: null, w: 1 }] : [{ bet: allowed[0], w: 1 }]),
};

function normEcon(e) { return { capMode: 'block', ...e, bets: [...e.bets].sort((x, y) => x.stake - y.stake) }; }

function allowedBets(econ, stack, net, feeDue) {
  return econ.bets.filter((b) => stack - feeDue - b.stake >= 0
    && net - feeDue - b.stake >= -econ.lossLimit
    && (econ.capMode !== 'block' || net - feeDue - b.stake + b.returnOnWin <= econ.winCap));
}
function blockedReason(econ, stack, net, feeDue) {
  const b = econ.bets[0];
  if (stack - feeDue - b.stake < 0) return 'broke';
  if (net - feeDue - b.stake < -econ.lossLimit) return 'lossLimit';
  return 'winCap';
}

function exactSession(econIn, p, policyName = 'playAll', { buyIn = 10, maxRounds } = {}) {
  const econ = normEcon(econIn);
  const R = maxRounds ?? econ.maxRounds;
  const policy = POLICIES[policyName];
  const add = (m, k, v) => m.set(k, (m.get(k) || 0) + v);
  let cur = new Map([[buyIn, 1]]);
  const dist = new Map();
  const ends = { rounds: 0, lossLimit: 0, winCap: 0, broke: 0, quit: 0 };
  let eWag = 0, eFee = 0, eRounds = 0, pBust = 0;
  for (let r = 0; cur.size; r++) {
    const next = new Map();
    for (const [stack, pr] of cur) {
      const net = stack - buyIn;
      const feeDue = r === 0 ? econ.fee : 0;
      let reason = null, acts = null;
      if (r >= R) reason = 'rounds';
      else if (econ.capMode === 'stopAfter' && net >= econ.winCap) reason = 'winCap';
      else {
        const allowed = allowedBets(econ, stack, net, feeDue);
        if (!allowed.length) reason = blockedReason(econ, stack, net, feeDue);
        else acts = policy({ r, net, allowed });
      }
      if (reason) { ends[reason] += pr; add(dist, net, pr); if (stack === 0) pBust += pr; continue; }
      for (const { bet, w } of acts) {
        const q = pr * w;
        if (!bet) { ends.quit += q; add(dist, net, q); if (stack === 0) pBust += q; continue; }
        eWag += q * bet.stake; eFee += q * feeDue; eRounds += q;
        const after = stack - feeDue - bet.stake;
        add(next, after + bet.returnOnWin, q * p);
        add(next, after, q * (1 - p));
      }
    }
    cur = next;
  }
  const keys = [...dist.keys()].sort((a, b) => a - b);
  let mean = 0, m2 = 0;
  for (const k of keys) { const v = dist.get(k); mean += k * v; m2 += k * k * v; }
  const q = (x) => { let c = 0; for (const k of keys) { c += dist.get(k); if (c >= x - 1e-12) return k; } return keys[keys.length - 1]; };
  const live = keys.filter((k) => dist.get(k) > 1e-12);
  const P = (pred) => keys.filter(pred).reduce((s, k) => s + dist.get(k), 0);
  return {
    p, mean, sd: Math.sqrt(Math.max(0, m2 - mean * mean)),
    p5: q(0.05), p25: q(0.25), p50: q(0.5), p75: q(0.75), p95: q(0.95),
    min: live[0], max: live[live.length - 1],
    pAhead: P((k) => k > 0), pEvenOrBetter: P((k) => k >= 0), pLose5: P((k) => k <= -5), pGain5: P((k) => k >= 5),
    pBust, ends, eRounds, eWag, eFee,
    rtp: 1 + mean / (eWag + eFee),
    dist: Object.fromEntries(keys.map((k) => [k, dist.get(k)])),
  };
}

function breakEven(econ, policy = 'playAll', opts = {}) {
  let lo = 0.2, hi = 0.7;
  for (let i = 0; i < 50; i++) { const mid = (lo + hi) / 2; if (exactSession(econ, mid, policy, opts).mean < 0) lo = mid; else hi = mid; }
  return (lo + hi) / 2;
}

// Monte Carlo session (same rules) used inside the festival sim, where hits must be tracked for the guard.
function mcSession(econ, p, policyName, buyIn, maxRounds) {
  const R = maxRounds ?? econ.maxRounds;
  const policy = POLICIES[policyName];
  let stack = buyIn, rounds = 0, hits = 0, wag = 0, fee = 0;
  for (;;) {
    const net = stack - buyIn;
    const feeDue = rounds === 0 ? econ.fee : 0;
    if (rounds >= R) break;
    if (econ.capMode === 'stopAfter' && net >= econ.winCap) break;
    const allowed = allowedBets(econ, stack, net, feeDue);
    if (!allowed.length) break;
    const acts = policy({ r: rounds, net, allowed });
    let u = rng(), bet = acts[acts.length - 1].bet;
    for (const a of acts) { if ((u -= a.w) < 0) { bet = a.bet; break; } }
    if (!bet) break;
    stack -= feeDue + bet.stake; fee += feeDue; wag += bet.stake; rounds++;
    if (rng() < p) { stack += bet.returnOnWin; hits++; }
  }
  return { net: stack - buyIn, rounds, hits, wag, fee };
}

// ---------------------------------------------------------------------------
// PART C. Festival day (booth bankruptcy risk), Monte Carlo
// ---------------------------------------------------------------------------
function wilsonLB(h, n, z) {
  if (n === 0) return 0;
  const ph = h / n, z2 = z * z;
  return (ph + z2 / (2 * n) - z * Math.sqrt((ph * (1 - ph) + z2 / (4 * n)) / n)) / (1 + z2 / n);
}

function simFestivalDay(scn, guard) {
  const V = CFG.booth.expectedVisitorsPerDay, C = CFG.booth.chipsPerVisitor;
  const econ = normEcon(CFG.tiers.hardest.economy);
  const maxRounds = CFG.booth.busyMode ? econ.busyMaxRounds : econ.maxRounds;
  let outstanding = 0, booth = 0, boothMin = 0, sessions = 0, rounds = 0, maxVisitor = 0, n = 0, h = 0, paused = false, stopped = false;
  for (let v = 0; v < V; v++) {
    let chips = C;
    if (rng() < scn.pPlay) {
      const p = pickWeighted(scn.skill).p;
      const pol = pickWeighted(scn.policies).name;
      for (let s = 0; s < scn.maxSessions; s++) {
        if (s > 0 && rng() >= scn.pReplay) break;
        if (guard && (paused || stopped)) break;
        if (chips < econ.minBuyIn) break;
        const r = mcSession(econ, p, pol, Math.min(econ.maxBuyIn, chips), maxRounds);
        chips += r.net; sessions++; rounds += r.rounds;
        booth -= r.net; if (booth < boothMin) boothMin = booth;
        n += r.rounds; h += r.hits;
        if (guard) {
          if (n >= guard.minRounds && wilsonLB(h, n, guard.z) > guard.pauseAt.hardest) paused = true;
          if (booth < guard.boothStopLoss) stopped = true;
        }
      }
    }
    outstanding += chips; if (chips > maxVisitor) maxVisitor = chips;
  }
  return { issued: V * C, outstanding, booth, boothMin, sessions, rounds, maxVisitor, paused, stopped };
}

function quantile(sorted, q) { return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))))]; }

function partC(A, sessionSec) {
  const H = A.hardest;
  const skillReal = [
    { p: 1 / 3, w: 0.4 }, { p: H.human['캐주얼'], w: 0.35 }, { p: H.human['숙련'], w: 0.2 }, { p: H.human['완벽 지각'], w: 0.05 },
  ];
  const scenarios = {
    '현실적 혼합': { pPlay: 0.8, pReplay: 0.25, maxSessions: 3, skill: skillReal, policies: [{ name: 'playAll', w: 0.85 }, { name: 'quitter', w: 0.15 }] },
    '최악(누수 없음): 전원 이상적 관찰자, 3세션': { pPlay: 1, pReplay: 1, maxSessions: 3, skill: [{ p: H.meanCeiling, w: 1 }], policies: [{ name: 'playAll', w: 1 }] },
    '고장: 렌더링 누수로 전원 p=0.40, 3세션': { pPlay: 1, pReplay: 1, maxSessions: 3, skill: [{ p: 0.4, w: 1 }], policies: [{ name: 'playAll', w: 1 }] },
  };
  const out = [];
  for (const [name, scn] of Object.entries(scenarios)) {
    for (const guard of [null, CFG.guard]) {
      const nets = [], outs = [], mins = [];
      let exceed = 0, sessions = 0, rounds = 0, maxVisitor = 0, pausedDays = 0, stoppedDays = 0;
      for (let f = 0; f < N_FEST; f++) {
        const r = simFestivalDay(scn, guard);
        nets.push(r.booth); outs.push(r.outstanding / r.issued); mins.push(r.boothMin);
        if (r.outstanding > r.issued) exceed++;
        sessions += r.sessions; rounds += r.rounds;
        if (r.maxVisitor > maxVisitor) maxVisitor = r.maxVisitor;
        if (r.paused) pausedDays++;
        if (r.stopped) stoppedDays++;
      }
      nets.sort((a, b) => a - b); outs.sort((a, b) => a - b); mins.sort((a, b) => a - b);
      const mean = nets.reduce((a, b) => a + b, 0) / N_FEST;
      const spd = sessions / N_FEST;
      out.push({
        scenario: name, guard: !!guard, days: N_FEST, issued: CFG.booth.expectedVisitorsPerDay * CFG.booth.chipsPerVisitor,
        boothMean: mean, boothPerVisitor: mean / CFG.booth.expectedVisitorsPerDay, boothPerSession: mean / spd,
        boothP1: quantile(nets, 0.01), boothMin: nets[0], runningMinP1: quantile(mins, 0.01),
        pOverBudget: exceed / N_FEST, outP50: quantile(outs, 0.5), outP99: quantile(outs, 0.99),
        sessionsPerDay: spd, roundsPerDay: rounds / N_FEST, staffHours: (spd * sessionSec) / 3600,
        maxVisitor, pPaused: pausedDays / N_FEST, pStopLoss: stoppedDays / N_FEST,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// PART D. Leak alarm power (Wilson one-sided lower bound, checked every 10 rounds after 60)
// ---------------------------------------------------------------------------
function partD(A) {
  const g = CFG.guard, hc = A.hardest.meanCeiling;
  const cases = [['WARN (LB > 평균 상한)', hc], ['PAUSE (LB > ' + g.pauseAt.hardest + ')', g.pauseAt.hardest]];
  const ps = [1 / 3, hc, 0.36, 0.38, 0.4, 0.45];
  const out = [];
  for (const [name, thr] of cases) {
    for (const pTrue of ps) {
      let fired = 0; const at = [];
      for (let t = 0; t < N_ALARM; t++) {
        let h = 0;
        for (let n = 1; n <= ALARM_HORIZON; n++) {
          if (rng() < pTrue) h++;
          if (n >= g.minRounds && n % g.checkEvery === 0 && wilsonLB(h, n, g.z) > thr) { fired++; at.push(n); break; }
        }
      }
      at.sort((a, b) => a - b);
      out.push({ alarm: name, threshold: thr, pTrue, pFire: fired / N_ALARM, medianRounds: at.length ? quantile(at, 0.5) : null });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------
function pct(x, d = 1) { return (100 * x).toFixed(d) + '%'; }
function f(x, d = 2) { return Number(x).toFixed(d); }
function sg(x) { return x > 0 ? '+' + x : String(x); }
function sgf(x, d = 2) { const s = Number(x).toFixed(d); return x > 0 ? '+' + s : s; }
function table(head, rows) {
  const lines = ['| ' + head.join(' | ') + ' |', '|' + head.map(() => '---').join('|') + '|'];
  for (const r of rows) lines.push('| ' + r.join(' | ') + ' |');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
const t0 = Date.now();
const results = { generatedAt: new Date().toISOString(), seed: SEED, quick: QUICK, config: CONFIG_PATH };
const H = normEcon(CFG.tiers.hardest.economy);
const NE = normEcon(CFG.tiers.normal.economy);

console.log(`# 야바위 시뮬레이션 결과 (seed ${SEED}${QUICK ? ', quick' : ''}, config ${CONFIG_PATH.replace(ROOT + '/', '')})\n`);

// ---- A
const A = partA();
results.shuffle = A;
console.log(`## A. 셔플 생성기와 이상적 관찰자 상한 (난이도마다 ${N_ROUNDS.toLocaleString()}판)\n`);
console.log(table(
  ['난이도', '동작 수', '겹치기/회전', '셔플 시간', '생성 시도 평균/최대', '상한 평균 / 최대', '상한 분포(상위)', '이상적 베이즈', '완벽 지각', '숙련', '캐주얼', '시작 컵 고정', '가운데 고정', '무작위', 'χ²(6df)'],
  Object.values(A).map((r) => [
    r.label, f(r.meanMoves, 1), `${f(r.meanOverlaps, 1)} / ${f(r.meanRotations, 1)}`, f(r.meanShuffleSec, 1) + 's', `${f(r.meanTries, 1)} / ${r.maxTries}`,
    `${f(r.meanCeiling, 4)} / ${f(r.maxCeiling, 4)}`, r.ceilingTop.join(', '),
    f(r.bayesHit, 4), f(r.human['완벽 지각'], 4), f(r.human['숙련'], 4), f(r.human['캐주얼'], 4),
    f(r.startCupHit, 4), f(r.middleHit, 4), f(r.randomHit, 4), f(r.chi2FinalGivenStart, 1),
  ]),
));
console.log(`\nχ²(최종 위치 | 시작 위치, 자유도 6) 99% 임계값 = 16.81. 표준오차(적중률) ≈ ${f(Math.sqrt(0.25 / N_ROUNDS), 4)}.\n`);

// ---- B1: hardest by hit rate
const be = breakEven(H);
const beBusy = breakEven(H, 'playAll', { maxRounds: H.busyMaxRounds });
results.breakEven = { hardest: be, hardestBusy: beBusy };
const hc = A.hardest.meanCeiling;
const gridH = [0.3, 1 / 3, hc, CFG.tiers.hardest.shuffle.ceiling.cMax, 0.35, 0.36, be, 0.4, 0.45];
const label = (p) => (Math.abs(p - 1 / 3) < 1e-9 ? '1/3 (무작위, 사람 대부분)' : Math.abs(p - hc) < 1e-9 ? f(p, 4) + ' (이상적 관찰자 평균)' : Math.abs(p - be) < 1e-9 ? f(p, 4) + ' (세션 손익분기)' : Math.abs(p - CFG.tiers.hardest.shuffle.ceiling.cMax) < 1e-9 ? f(p, 5) + ' (판별 상한 cMax)' : f(p, 2));
const sessRow = (r, perRound) => [
  perRound, pct(r.rtp), sgf(r.mean), f(r.sd), sg(r.p5), sg(r.p50), sg(r.p95), `${sg(r.min)} / ${sg(r.max)}`,
  pct(r.pBust), pct(r.ends.lossLimit), pct(r.ends.winCap), pct(r.pEvenOrBetter), f(r.eRounds, 2), sgf(-r.mean),
];
const sessHead = ['한 판 RTP', '세션 RTP', '평균', '표준편차', 'p5', 'p50', 'p95', '최소 / 최대', '파산(0칩)', '손실한도 도달', '최대획득 도달', '본전 이상', '평균 판수', '부스/방문자'];
const B1 = gridH.map((p) => ({ p, ...exactSession(H, p, 'playAll') }));
results.hardestSessions = B1.map(({ dist, ...r }) => r);
console.log(`## B1. 최상 (1칩 걸고 맞히면 3칩, 참가비 1칩, ${H.maxRounds}판, 최대 +${H.winCap}, 손실 한도 ${H.lossLimit}, 버이인 10) — 정확 계산\n`);
console.log(table(['적중률 p', ...sessHead], B1.map((r) => [label(r.p), ...sessRow(r, pct(r.p * 3))])));
console.log(`\n세션 손익분기 적중률 = ${f(be, 4)} (바쁨 모드 ${H.busyMaxRounds}판: ${f(beBusy, 4)}). 이상적 관찰자 평균 상한과의 여유 = ${f(be - hc, 4)}. 부스/방문자 = 방문자 1명이 이 조건으로 1세션 할 때 부스가 얻는 칩.`);
const d13 = B1[1].dist;
console.log(`\np = 1/3 정확 분포 (버이인 10): ` + Object.entries(d13).map(([k, v]) => [Number(k), v]).sort((a, b) => a[0] - b[0]).filter(([, v]) => v > 1e-6).map(([k, v]) => `${sg(k)}: ${pct(v, 2)}`).join(', ') + '\n');

// ---- B2: buy-in sensitivity
console.log(`## B2. 최상, 버이인별 (p = 1/3 / 이상적 관찰자) — 정확 계산. 기본 최소 버이인 = ${H.minBuyIn} (3, 5는 참고용)\n`);
const B2 = [];
for (const buyIn of [3, 5, 7, 8, 10]) for (const p of [1 / 3, hc]) B2.push({ buyIn, ...exactSession(H, p, 'playAll', { buyIn }) });
results.buyInSensitivity = B2.map(({ dist, ...r }) => r);
console.log(table(['버이인', 'p', '세션 RTP', '평균', 'p5', 'p50', 'p95', '최소 / 최대', '파산(0칩)', '손실한도 도달'],
  B2.map((r) => [r.buyIn, f(r.p, 4), pct(r.rtp), sgf(r.mean), sg(r.p5), sg(r.p50), sg(r.p95), `${sg(r.min)} / ${sg(r.max)}`, pct(r.pBust), pct(r.ends.lossLimit)])));
console.log('');

// ---- B3: hardest variants
console.log('## B3. 최상 규칙 대안 비교 (버이인 10) — 정확 계산\n');
const base = CFG.tiers.hardest.economy;
const variants = [
  ['**채택**: 1→3, 참가비 1, 8판, +10 상한, 손실 6', base, 'playAll', {}],
  [`바쁨 모드: ${base.busyMaxRounds}판`, base, 'playAll', { maxRounds: base.busyMaxRounds }],
  ['6판', base, 'playAll', { maxRounds: 6 }],
  ['중도 정산 정책(+4 / −5에서 그만)', base, 'quitter', {}],
  ['참가비 없음', { ...base, fee: 0 }, 'playAll', {}],
  ['참가비 2 (누수 의심 시 비상 설정)', { ...base, fee: 2 }, 'playAll', {}],
  ['10판', { ...base, maxRounds: 10 }, 'playAll', {}],
  ['1~2칩 허용(1→3, 2→6), 항상 최대', { ...base, bets: [{ stake: 1, returnOnWin: 3 }, { stake: 2, returnOnWin: 6 }] }, 'maxBet', {}],
  ['손실 한도 없음', { ...base, lossLimit: 10 }, 'playAll', {}],
  ['제안 P안: 2→5, 참가비 없음, 5판, 보호 4칩, +10 도달 시 종료', { ...base, fee: 0, bets: [{ stake: 2, returnOnWin: 5 }], maxRounds: 5, capMode: 'stopAfter' }, 'playAll', {}],
  ['제안 R안: 2→5 / 4→10, 8판, 손실 6, +10 도달 시 종료, 70:30 베팅', { ...base, fee: 0, bets: [{ stake: 2, returnOnWin: 5 }, { stake: 4, returnOnWin: 10 }], maxRounds: 8, capMode: 'stopAfter' }, 'mixed7030', {}],
];
const B3 = variants.map(([name, econ, pol, opts]) => {
  const a = exactSession(econ, 1 / 3, pol, opts), b = exactSession(econ, hc, pol, opts), c = exactSession(econ, 0.4, pol, opts);
  return { name, a, b, c, be: breakEven(econ, pol, opts) };
});
results.hardestVariants = B3.map(({ name, a, b, c, be: x }) => ({ name, breakEven: x, p333: strip(a), ideal: strip(b), p40: strip(c) }));
function strip({ dist, ...r }) { return r; }
console.log(table(['규칙', '세션 RTP (1/3 / 이상적)', '평균 (1/3 / 이상적 / 0.40)', '표준편차', 'p5 / p50 / p95 (1/3)', '최소 / 최대', '손실 ≥5칩 확률', '본전 이상', '평균 판수', '세션 손익분기 p'],
  B3.map(({ name, a, b, c, be: x }) => [name, `${pct(a.rtp)} / ${pct(b.rtp)}`, `${sgf(a.mean)} / ${sgf(b.mean)} / ${sgf(c.mean)}`, f(a.sd), `${sg(a.p5)} / ${sg(a.p50)} / ${sg(a.p95)}`, `${sg(a.min)} / ${sg(a.max)}`, pct(a.pLose5), pct(a.pEvenOrBetter), f(a.eRounds, 1), f(x, 3)])));
console.log('');

// ---- B4: normal if it were paid (reference only)
console.log(`## B4. (참고, 채택 안 함) 보통을 유료로 켤 경우: 1→2 / 2→4, 참가비 없음, ${NE.maxRounds}판 — 정확 계산\n`);
const nc = A.normal.meanCeiling;
const gridN = [1 / 3, 0.4, A.normal.human['캐주얼'], A.normal.human['숙련'], nc, 0.5, 0.55];
const B4 = [];
for (const p of gridN) for (const pol of ['playAll', 'maxBet']) B4.push({ pol, ...exactSession(NE, p, pol) });
results.normalPaidReference = B4.map(strip);
console.log(table(['적중률 p', '베팅', ...sessHead],
  B4.map((r) => [Math.abs(r.p - 1 / 3) < 1e-9 ? '1/3' : Math.abs(r.p - nc) < 1e-9 ? f(r.p, 4) + ' (이상적 관찰자)' : f(r.p, 4), r.pol === 'playAll' ? '항상 1칩' : '항상 2칩', ...sessRow(r, pct(r.p * 2))])));
console.log(`\n보통 이상적 관찰자 상한 ${f(nc, 4)} vs 손익분기 0.5000 → 누수 여유 ${f(0.5 - nc, 4)} (가드 최소 ${CFG.guard.minLeakMargin}). 일부 판은 상한이 정확히 0.5라 그 판의 여유는 0.\n`);

// ---- throughput
const T = CFG.timing;
const roundSec = (T.showBallMs + A.hardest.meanShuffleSec * 1000 + ASSUME.pickAvgMs + T.revealMs + T.resultMs) / 1000;
const freeRoundSec = (T.showBallMs + A.normal.meanShuffleSec * 1000 + ASSUME.pickAvgMs + T.revealMs + T.resultMs) / 1000;
const sessionSec = ASSUME.sessionOverheadSec + B1[1].eRounds * roundSec + ASSUME.warmupRoundsAvg * freeRoundSec;
const busySessionSec = ASSUME.sessionOverheadSec + exactSession(H, 1 / 3, 'playAll', { maxRounds: H.busyMaxRounds }).eRounds * roundSec;
results.throughput = { roundSec, freeRoundSec, sessionSec, sessionsPerHour: 3600 / sessionSec, busySessionSec, busySessionsPerHour: 3600 / busySessionSec };

// ---- C
const C = partC(A, sessionSec);
results.festival = C;
console.log(`## C. 축제 하루 (방문자 ${CFG.booth.expectedVisitorsPerDay}명 × ${CFG.booth.chipsPerVisitor}칩 = ${CFG.booth.expectedVisitorsPerDay * CFG.booth.chipsPerVisitor}칩 발행, ${N_FEST.toLocaleString()}일 반복, 칩 게임은 최상만)\n`);
console.log(table(['시나리오', '가드', '부스 순이익 평균', '방문자당', '세션당', 'p1', '최악', '발행량 초과 확률', '남은 칩 p50 / p99', '세션/일', '직원 시간', '최다 보유 방문자', '자동 일시정지', '손절 발동'],
  C.map((r) => [r.scenario, r.guard ? '켬' : '끔', sgf(r.boothMean, 0), sgf(r.boothPerVisitor), sgf(r.boothPerSession), sg(r.boothP1), sg(r.boothMin), pct(r.pOverBudget, 2), `${pct(r.outP50)} / ${pct(r.outP99)}`, f(r.sessionsPerDay, 0), f(r.staffHours, 1) + 'h', r.maxVisitor, pct(r.pPaused, 2), pct(r.pStopLoss, 2)])));
console.log('\n현실적 혼합: 방문자 80%가 플레이, 추가 세션 확률 25%(최대 3세션, 칩이 최소 버이인 이상일 때만). 실력 분포 40% 무작위(1/3), 35% 캐주얼, 20% 숙련, 5% 완벽 지각(적중률은 A표 값). 85% 끝까지 플레이, 15% 중도 정산.\n');

// ---- D
const D = partD(A);
results.alarm = D;
console.log(`## D. 누수 경보 탐지력 (최상, Wilson 단측 z=${CFG.guard.z}, ${CFG.guard.minRounds}판 이후 ${CFG.guard.checkEvery}판마다 검사, ${ALARM_HORIZON}판 안에 울릴 확률)\n`);
console.log(table(['경보', '실제 p', '울릴 확률', '울릴 때까지 판수(중앙값)'], D.map((r) => [r.alarm, f(r.pTrue, 4), pct(r.pFire), r.medianRounds ?? '—'])));
console.log('');

// ---- throughput print
console.log('## E. 처리량 (한 대 기준)\n');
console.log(table(['항목', '값'], [
  ['최상 한 판 (공 보여주기 + 셔플 + 선택 + 공개 + 결과)', f(roundSec, 1) + 's'],
  ['세션 (평균 ' + f(B1[1].eRounds, 1) + '판 + 무료 ' + ASSUME.warmupRoundsAvg + '판 + 접수/정산 ' + ASSUME.sessionOverheadSec + 's)', f(sessionSec / 60, 2) + '분 → 시간당 ' + f(3600 / sessionSec, 0) + '세션'],
  ['바쁨 모드 (' + H.busyMaxRounds + '판, 무료 판 없음)', f(busySessionSec / 60, 2) + '분 → 시간당 ' + f(3600 / busySessionSec, 0) + '세션'],
]));

console.log(`\n(실행 시간 ${((Date.now() - t0) / 1000).toFixed(1)}s)`);
if (JSON_OUT) { writeFileSync(resolve(JSON_OUT), JSON.stringify(results, null, 2)); console.log('wrote ' + resolve(JSON_OUT)); }
