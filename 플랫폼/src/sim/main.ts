// 확률 시뮬레이터 (/sim on the admin PC): pick a game and a guest's habit, simulate thousands of guests, and see how
// likely each ending is, from 0 chips (broke) to 50 (the physical-chip limit). The work runs in a worker
// (worker.ts → engine.ts, the games' own code); the page draws the distribution as bars, with the run before it
// as an outline to compare.
import './style.css';
import { PLATFORM } from '../shared/config.ts';
import { h, setText } from '../ui/dom.ts';
import { BOARDS, BOARD_IDS, type BoardId } from '../../games/plinko/src/table.ts';
import { DEFAULTS, LEVERAGE_LABEL, PACE, TOP, YABAWI_PLAYER_LABEL, type SimGame, type SimParams, type SimResult, type TraderLeverage, type YabawiLevel, type YabawiPlayer } from './engine.ts';

const GAME_LABEL: Record<SimGame, string> = { plinko: '🔮 플링코', slot: '🎰 슬롯머신', yacht: '🎲 요트 다이스', yabawi: '🥤 야바위', yeongkkeul: '📈 영끌문S' };
const GAMES = Object.keys(GAME_LABEL) as SimGame[];
const GUESTS: Record<SimGame, number> = { plinko: 20000, slot: 20000, yacht: 20000, yabawi: 20000, yeongkkeul: 600 };
const YABAWI_LEVEL_LABEL: Record<YabawiLevel | 'random', string> = { random: '골고루', normal: '중간', high: '높음', hardest: '최상' };

interface Run {
  params: SimParams;
  result: SimResult;
  label: string;
}

const root = document.getElementById('app')!;
let params: SimParams = { ...DEFAULTS, game: 'plinko', perMin: PACE.plinko, guests: GUESTS.plinko };
let current: Run | null = null;
let previous: Run | null = null;
let worker: Worker | null = null;
let runId = 0;
let showPrev = true;
let hideZero = false;

// ---------------------------------------------------------------- controls

const field = (label: string, input: HTMLElement, note?: string): HTMLElement =>
  h('label', { class: 'sm-field' }, h('span', { class: 'sm-label' }, label), input, note ? h('small', {}, note) : '');

function num(value: number, min: number, max: number, step: number, set: (v: number) => void): HTMLInputElement {
  const el = h('input', { class: 'sm-input', type: 'number', min, max, step, value });
  el.addEventListener('change', () => {
    const v = Math.min(max, Math.max(min, Number(el.value) || min));
    el.value = String(v);
    set(v);
  });
  return el;
}

function seg<T extends string>(options: [T, string][], value: T, set: (v: T) => void, testid?: string): HTMLElement {
  const box = h('div', { class: 'sm-seg', role: 'group', ...(testid ? { 'data-testid': testid } : {}) });
  const paint = (v: T): void => [...box.children].forEach((b, i) => b.classList.toggle('on', options[i][0] === v));
  for (const [v, label] of options)
    box.append(
      h(
        'button',
        {
          type: 'button',
          onclick: () => {
            paint(v);
            set(v);
          },
        },
        label,
      ),
    );
  paint(value);
  return box;
}

const extraEl = h('div', { class: 'sm-row' });
const habitEl = h('div', { class: 'sm-row' });
const runBtn = h('button', { class: 'sm-run', type: 'button', 'data-testid': 'sim-run', onclick: () => start() }, '시뮬레이션 실행');
const stopBtn = h('button', { class: 'sm-stop', type: 'button', hidden: true, onclick: () => stop() }, '중지');
const progressEl = h('div', { class: 'sm-progress', hidden: true }, h('div', { class: 'sm-progress-fill' }));
const statusEl = h('div', { class: 'sm-status', 'data-testid': 'sim-status' });

function renderControls(): void {
  const p = params;
  const extra: HTMLElement[] = [];
  if (p.game === 'plinko')
    extra.push(
      field(
        '난이도',
        seg<BoardId | 'random'>([['random', '골고루'], ...BOARD_IDS.map((id): [BoardId, string] => [id, BOARDS[id].label])], p.plinkoBoard, (v) => (params = { ...params, plinkoBoard: v })),
      ),
    );
  if (p.game === 'yabawi') {
    extra.push(
      field(
        '난이도',
        seg<YabawiLevel | 'random'>(
          (['random', 'normal', 'high', 'hardest'] as const).map((v): [YabawiLevel | 'random', string] => [v, YABAWI_LEVEL_LABEL[v]]),
          p.yabawiLevel,
          (v) => (params = { ...params, yabawiLevel: v }),
        ),
      ),
      field(
        '손님 실력',
        seg<YabawiPlayer>(
          (Object.keys(YABAWI_PLAYER_LABEL) as YabawiPlayer[]).map((v): [YabawiPlayer, string] => [v, YABAWI_PLAYER_LABEL[v]]),
          p.yabawiPlayer,
          (v) => (params = { ...params, yabawiPlayer: v }),
        ),
      ),
    );
  }
  if (p.game === 'yacht') extra.push(h('p', { class: 'sm-hint' }, '보통 손님 기준(큰 묶음 → 4연속 → 한 쌍 → 5·6 순으로 남김)으로 굴립니다.'));
  if (p.game === 'yeongkkeul')
    extra.push(
      field(
        '레버리지 성향',
        seg<TraderLeverage>(
          (Object.keys(LEVERAGE_LABEL) as TraderLeverage[]).map((v): [TraderLeverage, string] => [v, LEVERAGE_LABEL[v]]),
          p.leverage,
          (v) => (params = { ...params, leverage: v }),
        ),
      ),
      h(
        'p',
        { class: 'sm-hint' },
        '실제 시장으로 거래합니다: 잔고를 모두 가져가서, 무작위 종목·방향(인버스 30%)으로 20~90초 들고 팝니다. 레버리지는 평가 자산이 시작의 2배가 되면 열립니다. 손님 한 명에 시간이 걸려 손님 수가 적습니다.',
      ),
    );
  extraEl.replaceChildren(...extra);

  const share = p.bet.kind === 'share' ? p.bet : { lo: 0.5, hi: 1 };
  const fixed = p.bet.kind === 'fixed' ? p.bet.chips : 1;
  const betBox = h('div', { class: 'sm-bet' });
  const paintBet = (): void => {
    betBox.replaceChildren(
      ...(params.bet.kind === 'share'
        ? [
            h('span', {}, '잔고의'),
            num(Math.round(share.lo * 100), 1, 100, 5, (v) => (params = { ...params, bet: { kind: 'share', lo: v / 100, hi: Math.max(v / 100, params.bet.kind === 'share' ? params.bet.hi : 1) } })),
            h('span', {}, '% ~'),
            num(Math.round(share.hi * 100), 1, 100, 5, (v) => (params = { ...params, bet: { kind: 'share', lo: Math.min(v / 100, params.bet.kind === 'share' ? params.bet.lo : 0.5), hi: v / 100 } })),
            h('span', {}, '%'),
          ]
        : [num(fixed, 1, 1000, 1, (v) => (params = { ...params, bet: { kind: 'fixed', chips: v } })), h('span', {}, '칩씩')]),
    );
  };
  paintBet();
  habitEl.replaceChildren(
    field('시작 칩', num(p.start, 1, 1000, 1, (v) => (params = { ...params, start: v }))),
    field(
      '거는 방식',
      h(
        'div',
        { class: 'sm-stack' },
        seg<'share' | 'fixed'>(
          [
            ['share', '잔고 비율'],
            ['fixed', '고정 칩'],
          ],
          p.bet.kind,
          (v) => {
            params = { ...params, bet: v === 'share' ? { kind: 'share', lo: share.lo, hi: share.hi } : { kind: 'fixed', chips: fixed } };
            paintBet();
          },
        ),
        betBox,
      ),
    ),
    field('플레이 시간', h('div', { class: 'sm-unit' }, num(p.minutes, 1, 240, 1, (v) => (params = { ...params, minutes: v })), h('span', {}, '분'))),
    p.game === 'yeongkkeul'
      ? ''
      : field('분당 판 수', num(p.perMin, 0.5, 120, 0.5, (v) => (params = { ...params, perMin: v })), '게임 속도 · 손님마다 다름'),
    field(
      '멈추는 칩',
      h('div', { class: 'sm-unit' }, num(p.goal, 0, 10000, 1, (v) => (params = { ...params, goal: v })), h('span', {}, '칩')),
      `여기 닿으면 정산하고 끝 · 0이면 끝까지 · 실물 한도 ${PLATFORM.settleMax}`,
    ),
    field('손님 수', num(p.guests, 10, 200000, 10, (v) => (params = { ...params, guests: v }))),
  );
}

const gameSeg = seg<SimGame>(
  GAMES.map((g): [SimGame, string] => [g, GAME_LABEL[g]]),
  params.game,
  (g) => {
    params = { ...params, game: g, perMin: PACE[g] || params.perMin, guests: GUESTS[g] };
    renderControls();
  },
  'sim-game',
);

// ---------------------------------------------------------------- results

const tilesEl = h('div', { class: 'sm-tiles' });
const legendEl = h('div', { class: 'sm-legend' });
const chartEl = h('div', { class: 'sm-chart', 'data-testid': 'sim-chart' });
const tipEl = h('div', { class: 'sm-tip', hidden: true });
const tableEl = h('div', { class: 'sm-table' });
const prevToggle = h('input', { type: 'checkbox', checked: true });
prevToggle.addEventListener('change', () => {
  showPrev = prevToggle.checked;
  draw();
});
const luckToggle = h('input', { type: 'checkbox', checked: true, 'data-testid': 'sim-luck' });
luckToggle.addEventListener('change', () => (params = { ...params, luck: luckToggle.checked }));
const zeroToggle = h('input', { type: 'checkbox' });
zeroToggle.addEventListener('change', () => {
  hideZero = zeroToggle.checked;
  draw();
});

root.append(
  h('header', { class: 'sm-head' }, h('h1', {}, '확률 시뮬레이터'), h('p', {}, '손님 한 명이 게임을 마치고 남기는 칩: 0칩(파산)부터 50칩 이상까지, 각각의 확률')),
  h(
    'section',
    { class: 'sm-panel' },
    field('게임', gameSeg),
    extraEl,
    habitEl,
    h(
      'label',
      { class: 'sm-check' },
      luckToggle,
      '승리 추세 적용 (잔고를 게임마다 정한 중심 쪽으로 끌어당김: 적으면 덜 잃고, 많으면 덜 땀)',
    ),
    h('div', { class: 'sm-actions' }, runBtn, stopBtn, progressEl, statusEl),
  ),
  h(
    'section',
    { class: 'sm-panel sm-result' },
    tilesEl,
    h(
      'div',
      { class: 'sm-chart-head' },
      legendEl,
      h('label', { class: 'sm-check' }, prevToggle, '이전 결과 겹쳐 보기'),
      h('label', { class: 'sm-check' }, zeroToggle, '0칩 막대 빼고 보기'),
    ),
    chartEl,
    h('details', { class: 'sm-details' }, h('summary', {}, '표로 보기'), tableEl),
  ),
  tipEl,
);

const pct = (x: number, d = 1): string => `${(x * 100).toFixed(d)}%`;

function describe(p: SimParams): string {
  const parts = [GAME_LABEL[p.game].replace(/^\S+ /, '')];
  if (p.game === 'plinko') parts.push(p.plinkoBoard === 'random' ? '난이도 골고루' : BOARDS[p.plinkoBoard].label);
  if (p.game === 'yabawi') parts.push(YABAWI_LEVEL_LABEL[p.yabawiLevel], YABAWI_PLAYER_LABEL[p.yabawiPlayer]);
  if (p.game === 'yeongkkeul') parts.push(`레버리지 ${LEVERAGE_LABEL[p.leverage]}`);
  if (!p.luck) parts.push('승리 추세 없음');
  parts.push(`${p.start}칩`, p.bet.kind === 'share' ? `잔고 ${Math.round(p.bet.lo * 100)}~${Math.round(p.bet.hi * 100)}%` : `${p.bet.chips}칩씩`, `${p.minutes}분`);
  return parts.join(' · ');
}

function renderTiles(r: Run): void {
  const c = r.result.counts;
  const n = r.result.guests;
  const above = c.slice(r.params.start + 1).reduce((a, x) => a + x, 0);
  const tile = (label: string, value: string, sub = ''): HTMLElement =>
    h('div', { class: 'sm-tile' }, h('div', { class: 'sm-tile-label' }, label), h('div', { class: 'sm-tile-value' }, value), sub ? h('div', { class: 'sm-tile-sub' }, sub) : '');
  tilesEl.replaceChildren(
    tile('평균 남는 칩', `${r.result.mean.toFixed(2)}칩`, `시작 ${r.params.start}칩 · 50 넘는 몫은 50으로`),
    tile('파산 (0칩)', pct(c[0] / n)),
    tile(`${TOP}칩 이상`, pct(c[TOP] / n, 2)),
    tile('시작보다 많이 남김', pct(above / n)),
    tile('실제 환수율', r.result.wagered ? pct(r.result.returned / r.result.wagered) : '—', `${r.result.rounds.toLocaleString('ko-KR')}판 · 손님 ${n.toLocaleString('ko-KR')}명`),
  );
}

function renderTable(): void {
  if (!current) return tableEl.replaceChildren();
  const prev = showPrev && previous ? previous : null;
  tableEl.replaceChildren(
    h(
      'table',
      {},
      h('thead', {}, h('tr', {}, h('th', {}, '남는 칩'), h('th', {}, '이번'), h('th', {}, '손님 수'), prev ? h('th', {}, '이전') : '')),
      h(
        'tbody',
        {},
        ...current.result.counts.map((n, k) =>
          h(
            'tr',
            {},
            h('td', {}, k === TOP ? `${TOP}칩 이상` : `${k}칩`),
            h('td', {}, pct(n / current!.result.guests, 2)),
            h('td', {}, n.toLocaleString('ko-KR')),
            prev ? h('td', {}, pct(prev.result.counts[k] / prev.result.guests, 2)) : '',
          ),
        ),
      ),
    ),
  );
}

// ---------------------------------------------------------------- chart (SVG, one bar per chip count)

const SVG = 'http://www.w3.org/2000/svg';
function s<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

/** 1, 2, 2.5, 5 × 10ⁿ steps, about 5 of them. */
function niceStep(max: number): number {
  const raw = max / 5;
  const mag = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * mag >= raw) return m * mag;
  return 10 * mag;
}

function draw(): void {
  tipEl.hidden = true;
  renderTable();
  if (!current) {
    chartEl.replaceChildren(h('div', { class: 'sm-empty' }, '조건을 정하고 [시뮬레이션 실행]을 누르세요'));
    legendEl.replaceChildren();
    return;
  }
  const prev = showPrev && previous ? previous : null;
  legendEl.replaceChildren(
    h('span', { class: 'sm-key now' }, h('i', {}), describe(current.params)),
    prev ? h('span', { class: 'sm-key prev' }, h('i', {}), `이전: ${describe(prev.params)}`) : '',
  );
  const W = Math.max(320, chartEl.clientWidth);
  const H = Math.round(Math.min(440, Math.max(260, W * 0.42)));
  const m = { l: 52, r: 12, t: 24, b: 34 };
  const pw = W - m.l - m.r;
  const ph = H - m.t - m.b;
  const first = hideZero ? 1 : 0;
  const ks = Array.from({ length: TOP + 1 - first }, (_, i) => i + first);
  const p = (run: Run, k: number): number => run.result.counts[k] / run.result.guests;
  const max = Math.max(...ks.map((k) => p(current!, k)), ...(prev ? ks.map((k) => p(prev, k)) : [0]), 1e-6);
  const step = niceStep(max);
  const top = Math.ceil(max / step) * step;
  const band = pw / ks.length;
  const bw = Math.max(2, Math.min(24, band - 2));
  const x = (i: number): number => m.l + i * band + (band - bw) / 2;
  const y = (v: number): number => m.t + ph * (1 - v / top);

  const svg = s('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `${describe(current.params)}: 남는 칩별 확률` });
  for (let v = 0; v <= top + 1e-12; v += step) {
    svg.append(s('line', { x1: m.l, x2: W - m.r, y1: y(v), y2: y(v), class: v === 0 ? 'sm-base' : 'sm-grid' }));
    const t = s('text', { x: m.l - 8, y: y(v) + 4, class: 'sm-axis', 'text-anchor': 'end' });
    t.textContent = pct(v, step < 0.01 ? 1 : 0);
    svg.append(t);
  }
  ks.forEach((k, i) => {
    if (k % 5 !== 0 && k !== first) return;
    const t = s('text', { x: m.l + i * band + band / 2, y: H - m.b + 18, class: 'sm-axis', 'text-anchor': 'middle' });
    t.textContent = k === TOP ? `${TOP}+` : String(k);
    svg.append(t);
  });
  const xl = s('text', { x: W - m.r, y: H - 4, class: 'sm-axis', 'text-anchor': 'end' });
  xl.textContent = '남는 칩';
  svg.append(xl);

  // This run: bars with a 4px rounded top, square at the baseline.
  ks.forEach((k, i) => {
    const v = p(current!, k);
    if (v <= 0) return;
    const x0 = x(i);
    const y0 = y(v);
    const hgt = y(0) - y0;
    const r = Math.min(4, bw / 2, hgt);
    svg.append(
      s('path', {
        class: 'sm-bar',
        d: `M${x0},${y(0)} V${y0 + r} Q${x0},${y0} ${x0 + r},${y0} H${x0 + bw - r} Q${x0 + bw},${y0} ${x0 + bw},${y0 + r} V${y(0)} Z`,
      }),
    );
  });
  // The run before: a step outline over the bars.
  if (prev) {
    let d = '';
    ks.forEach((k, i) => {
      const yy = y(p(prev, k));
      const xa = m.l + i * band;
      d += `${i === 0 ? 'M' : 'L'}${xa},${yy} H${xa + band} `;
    });
    svg.append(s('path', { class: 'sm-prev', d }));
  }
  // Direct labels on the two ends that matter: broke and the 50-chip limit.
  for (const k of [first === 0 ? 0 : -1, TOP]) {
    if (k < 0) continue;
    const i = ks.indexOf(k);
    const v = p(current, k);
    if (v <= 0) continue;
    const t = s('text', { x: m.l + i * band + band / 2, y: Math.max(m.t + 10, y(v) - 6), class: 'sm-value', 'text-anchor': i === 0 ? 'start' : 'end' });
    t.textContent = pct(v);
    svg.append(t);
  }
  // Hover: a full-height target per chip count.
  ks.forEach((k, i) => {
    const hit = s('rect', { x: m.l + i * band, y: m.t, width: band, height: ph, class: 'sm-hit' });
    hit.addEventListener('pointerenter', (e) => tip(e, k));
    hit.addEventListener('pointermove', (e) => tip(e, k));
    hit.addEventListener('pointerleave', () => (tipEl.hidden = true));
    svg.append(hit);
  });
  chartEl.replaceChildren(svg);
}

function tip(e: PointerEvent, k: number): void {
  if (!current) return;
  const c = current.result;
  const atLeast = c.counts.slice(k).reduce((a, x) => a + x, 0) / c.guests;
  const prev = showPrev && previous ? previous.result : null;
  tipEl.replaceChildren(
    h('b', {}, k === TOP ? `${TOP}칩 이상` : `${k}칩`),
    h('div', {}, `이번 ${pct(c.counts[k] / c.guests, 2)} (${c.counts[k].toLocaleString('ko-KR')}명)`),
    h('div', { class: 'sm-tip-sub' }, `${k}칩 이상 남길 확률 ${pct(atLeast, 1)}`),
    prev ? h('div', { class: 'sm-tip-sub' }, `이전 ${pct(prev.counts[k] / prev.guests, 2)}`) : '',
  );
  tipEl.hidden = false;
  const r = tipEl.getBoundingClientRect();
  tipEl.style.left = `${Math.min(window.innerWidth - r.width - 8, e.clientX + 14)}px`;
  tipEl.style.top = `${Math.max(8, e.clientY - r.height - 12)}px`;
}

// ---------------------------------------------------------------- running

function start(): void {
  stop();
  const id = ++runId;
  const p = { ...params };
  worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  runBtn.disabled = true;
  stopBtn.hidden = false;
  progressEl.hidden = false;
  setProgress(0);
  setText(statusEl, `${describe(p)} · 손님 ${p.guests.toLocaleString('ko-KR')}명 계산 중…`);
  const t0 = performance.now();
  worker.onmessage = (e: MessageEvent<{ id: number; type: 'progress' | 'done'; done?: number; result?: SimResult }>) => {
    if (e.data.id !== id) return;
    if (e.data.type === 'progress') return setProgress((e.data.done ?? 0) / p.guests);
    if (current) previous = current;
    current = { params: p, result: e.data.result!, label: describe(p) };
    finish();
    setText(statusEl, `완료 · ${((performance.now() - t0) / 1000).toFixed(1)}초`);
    renderTiles(current);
    draw();
  };
  worker.onerror = (e) => {
    finish();
    setText(statusEl, `오류: ${e.message}`);
  };
  worker.postMessage({ id, params: p });
}

function setProgress(f: number): void {
  (progressEl.firstElementChild as HTMLElement).style.width = `${Math.round(f * 100)}%`;
}

function finish(): void {
  worker?.terminate();
  worker = null;
  runBtn.disabled = false;
  stopBtn.hidden = true;
  progressEl.hidden = true;
}

function stop(): void {
  if (!worker) return;
  runId++;
  finish();
  setText(statusEl, '중지했습니다');
}

window.addEventListener('resize', () => draw());
renderControls();
draw();
