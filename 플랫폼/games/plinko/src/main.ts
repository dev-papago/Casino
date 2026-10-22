// 플링코: each ball is one round. Dropping it takes the stake, draws the landing slot (table.ts) and notes the
// payout with the ledger at once; the ball then bounces down a path that ends in that slot.
import './style.css';
import { Bank, type Delivery } from '../../arcade/bank.ts';
import { jitter } from '../../arcade/rng.ts';
import { mountShell, netText, toneOf, type Shell } from '../../arcade/shell.ts';
import { sfx } from '../../arcade/sound.ts';
import { h, setText } from '../../../src/ui/dom.ts';
import { BOARDS, BOARD_IDS, PLINKO_TILT, drawSlotTilted, pathTo, type Board, type BoardId } from './table.ts';

const W = 720;
const H = 660;
const TOP = 70;
const SPACE_X = 40;
const PEG_R = 4.5;
const BALL_R = 7;
const SEG_MS = 150; // one peg row
const BALLS = [1, 3, 5];

interface Ball {
  path: { x: number; y: number }[];
  t0: number;
  seg: number[]; // ms per segment
  slot: number;
  mult: number;
  payout: number;
  stake: number;
  color: string;
  done: boolean;
  lastSeg: number;
  trail: { x: number; y: number }[];
  finish: (payout: number) => Promise<Delivery>;
}

const root = document.getElementById('app')!;
const bank = new Bank('plinko');
const shell = await mountShell(root, bank, '네온 플링코', '🔮', rules);
if (shell) start(shell);

function rules(): HTMLElement {
  return h(
    'div',
    {},
    h('p', {}, '공 하나가 한 판입니다. 떨어뜨리는 순간 판돈이 나가고, 공이 떨어진 칸의 배율만큼 칩을 받습니다(판돈 포함).'),
    ...BOARD_IDS.map((id) => {
      const b = BOARDS[id];
      const sum = b.weights.reduce((a, w) => a + w, 0);
      const hit = b.weights.reduce((a, w, i) => a + (b.mults[i] > 1 ? w : 0), 0) / sum;
      return h('p', {}, h('b', {}, `${b.label}: `), `최고 ×${Math.max(...b.mults)} · 판돈보다 많이 받을 확률 ${Math.round(hit * 100)}%`);
    }),
    h('p', {}, '모든 난이도의 기대 환수율은 86%입니다.'),
  );
}

function start(shell: Shell): void {
  let boardId: BoardId = 'medium';
  let count = 1;
  let auto = false;
  let dropping = false;
  const balls: Ball[] = [];
  const glowPeg = new Map<string, number>();
  const glowSlot = new Map<number, number>();
  const pops: { x: number; y: number; text: string; color: string; t0: number }[] = [];

  const canvas = h('canvas', { class: 'pk-canvas', width: W, height: H, 'data-testid': 'plinko-board' });
  const history = h('div', { class: 'pk-history', 'data-testid': 'plinko-history' });
  const capNote = h('div', { class: 'pk-cap' });
  shell.stage.append(h('div', { class: 'pk-wrap' }, history, canvas, capNote));
  const ctx = canvas.getContext('2d')!;

  const boardBtns = BOARD_IDS.map((id) =>
    h('button', { class: 'ab-seg', type: 'button', 'data-testid': `board-${id}`, onclick: () => setBoard(id) }, BOARDS[id].label),
  );
  const countBtns = BALLS.map((n) => h('button', { class: 'ab-seg', type: 'button', onclick: () => setCount(n) }, `${n}개`));
  shell.extra.append(
    h('span', { class: 'ab-label' }, '난이도'),
    ...boardBtns,
    h('span', { class: 'ab-label pk-gap' }, '공'),
    ...countBtns,
  );
  const dropBtn = h('button', { class: 'ab-btn big', type: 'button', 'data-testid': 'drop', onclick: () => void drop() }, '공 떨어뜨리기');
  const autoBtn = h('button', { class: 'ab-btn ghost', type: 'button', 'data-testid': 'auto', onclick: () => toggleAuto() }, '자동: 끔');
  shell.actions.append(dropBtn, autoBtn);

  const board = (): Board => BOARDS[boardId];
  const pegs = (b: Board) => {
    const sy = (H - TOP - 90) / b.rows;
    const out: { x: number; y: number; r: number; c: number }[] = [];
    for (let r = 0; r < b.rows; r++) for (let c = 0; c < r + 3; c++) out.push({ x: W / 2 + (c - (r + 2) / 2) * SPACE_X, y: TOP + r * sy, r, c });
    return { list: out, sy, slotY: TOP + (b.rows - 1) * sy + 58 };
  };
  const slotX = (b: Board, i: number) => W / 2 + (i - b.rows / 2) * SPACE_X;

  function setBoard(id: BoardId): void {
    if (balls.some((b) => !b.done) || dropping) return;
    boardId = id;
    sfx.click();
    paintControls();
  }
  function setCount(n: number): void {
    count = n;
    sfx.click();
    paintControls();
  }
  function toggleAuto(): void {
    auto = !auto;
    sfx.click();
    paintControls();
    if (auto && !dropping) void drop();
  }

  function paintControls(): void {
    boardBtns.forEach((b, i) => b.classList.toggle('on', BOARD_IDS[i] === boardId));
    countBtns.forEach((b, i) => b.classList.toggle('on', BALLS[i] === count));
    const flying = balls.some((b) => !b.done);
    for (const b of boardBtns) b.disabled = flying || dropping;
    setText(autoBtn, auto ? '자동: 켜짐 (멈추기)' : '자동: 끔');
    autoBtn.classList.toggle('on', auto);
    dropBtn.disabled = dropping || bank.maxStake < 1;
    const top = Math.max(...board().mults);
    setText(capNote, `최고 ×${top} · 판돈 ${shell.stake()}칩이면 최대 ${shell.stake() * top}칩`);
  }

  async function drop(): Promise<void> {
    if (dropping) return;
    dropping = true;
    shell.lock(true);
    paintControls();
    try {
      do {
        for (let i = 0; i < count; i++) {
          const stake = shell.stake();
          if (bank.maxStake < stake || bank.free < stake) {
            auto = false;
            shell.say(bank.free < 1 ? '칩이 없습니다' : '칩이 모자랍니다', 'bad');
            break;
          }
          let round;
          try {
            round = await bank.begin(stake);
          } catch (e) {
            auto = false;
            sfx.error();
            shell.say((e as Error).message, 'bad');
            break;
          }
          const b = board();
          const slot = drawSlotTilted(b, (m) => bank.keep(stake, stake * m, PLINKO_TILT));
          const mult = b.mults[slot];
          const payout = stake * mult;
          round.live(payout);
          launch(b, slot, mult, payout, stake, round.finish);
          shell.refresh();
          await wait(count > 1 ? 120 : 60);
        }
        if (auto) await wait(900);
      } while (auto);
    } finally {
      dropping = false;
      shell.lock(false);
      paintControls();
    }
  }

  function launch(b: Board, slot: number, mult: number, payout: number, stake: number, finish: Ball['finish']): void {
    const p = pegs(b);
    const rights = pathTo(b, slot);
    const path: { x: number; y: number }[] = [{ x: W / 2 + jitter(-3, 3), y: 18 }];
    let k = 0;
    for (let r = 0; r < b.rows; r++) {
      path.push({ x: W / 2 + (k - r / 2) * SPACE_X + jitter(-1.5, 1.5), y: TOP + r * p.sy - PEG_R - BALL_R + 1 });
      if (rights[r]) k++;
    }
    path.push({ x: slotX(b, slot), y: p.slotY });
    const seg = path.slice(1).map((_, i) => (i === 0 ? 380 : i === path.length - 2 ? 260 : SEG_MS * jitter(0.85, 1.15)));
    const palette = ['#39e0ff', '#ff3d9a', '#3dff8f', '#ffd34d', '#b46bff'];
    balls.push({ path, t0: performance.now(), seg, slot, mult, payout, stake, color: palette[balls.length % palette.length], done: false, lastSeg: -1, trail: [], finish });
  }

  function landed(ball: Ball): void {
    ball.done = true;
    glowSlot.set(ball.slot, 1);
    const b = board();
    const tone = toneOf(ball.stake, ball.payout);
    pops.push({ x: slotX(b, ball.slot), y: pegs(b).slotY - 30, text: `×${ball.mult}`, color: slotColor(ball.mult), t0: performance.now() });
    addHistory(ball.mult);
    shell.say(`×${ball.mult} · ${netText(ball.stake, ball.payout)}`, tone);
    if (ball.mult >= 25) {
      sfx.jackpot();
      shell.banner(`×${ball.mult}!`, `${ball.payout}칩 당첨`, 'jackpot');
      canvas.classList.remove('shake');
      void canvas.offsetWidth;
      canvas.classList.add('shake');
    } else if (ball.mult >= 6) {
      sfx.bigWin();
      shell.banner(`×${ball.mult}`, `${ball.payout}칩`);
    } else if (tone === 'win') sfx.win();
    else if (tone === 'push') sfx.push();
    else sfx.lose();
    if (ball.payout > ball.stake) shell.coins(canvas, Math.min(40, 6 + ball.mult * 2));
    void ball.finish(ball.payout).then((how) => {
      shell.delivered(how, ball.payout);
      shell.refresh();
      paintControls();
    });
    paintControls();
  }

  function addHistory(mult: number): void {
    const tag = h('span', { class: 'pk-tag' }, `×${mult}`);
    tag.style.background = slotColor(mult);
    tag.style.color = mult >= 1 ? '#05060c' : '#e8ecff';
    history.prepend(tag);
    while (history.children.length > 14) history.lastChild?.remove();
  }

  function frame(now: number): void {
    const b = board();
    const p = pegs(b);
    ctx.clearRect(0, 0, W, H);
    // pegs
    for (const peg of p.list) {
      const key = `${peg.r}:${peg.c}`;
      const g = glowPeg.get(key) ?? 0;
      ctx.beginPath();
      ctx.arc(peg.x, peg.y, PEG_R + g * 2.5, 0, Math.PI * 2);
      ctx.fillStyle = g > 0 ? '#9ff4ff' : '#3a4670';
      ctx.shadowColor = '#39e0ff';
      ctx.shadowBlur = g * 18;
      ctx.fill();
      ctx.shadowBlur = 0;
      if (g > 0) glowPeg.set(key, Math.max(0, g - 0.05));
    }
    // slots
    for (let i = 0; i < b.mults.length; i++) {
      const x = slotX(b, i);
      const g = glowSlot.get(i) ?? 0;
      const m = b.mults[i];
      ctx.save();
      ctx.translate(x, p.slotY);
      ctx.scale(1 + g * 0.18, 1 + g * 0.18);
      ctx.fillStyle = slotColor(m);
      ctx.shadowColor = slotColor(m);
      ctx.shadowBlur = 6 + g * 24;
      ctx.beginPath();
      ctx.roundRect(-17, -15, 34, 30, 7);
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.fillStyle = m >= 1 ? '#05060c' : '#c9d2f5';
      ctx.font = `900 ${m >= 10 ? 12 : 13}px Pretendard, 'Malgun Gothic', sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(`×${m}`, 0, 1);
      ctx.restore();
      if (g > 0) glowSlot.set(i, Math.max(0, g - 0.025));
    }
    // balls
    for (const ball of balls) {
      if (ball.done) continue;
      let t = now - ball.t0;
      let i = 0;
      while (i < ball.seg.length && t > ball.seg[i]) t -= ball.seg[i++];
      if (i >= ball.seg.length) {
        landed(ball);
        continue;
      }
      if (i !== ball.lastSeg && i > 0) {
        // reached the peg of row i-1
        const r = i - 1;
        if (r < b.rows) {
          const peg = p.list.find((q) => q.r === r && Math.abs(q.x - ball.path[i].x) < SPACE_X / 2);
          if (peg) glowPeg.set(`${peg.r}:${peg.c}`, 1);
          sfx.peg(r);
        }
      }
      ball.lastSeg = i;
      const a = ball.path[i];
      const z = ball.path[i + 1];
      const f = t / ball.seg[i];
      const hop = i === 0 ? 0 : Math.min(18, p.sy * 0.45);
      const x = a.x + (z.x - a.x) * f;
      const y = i === 0 ? a.y + (z.y - a.y) * f * f : a.y + (z.y - a.y) * f * f - hop * 4 * f * (1 - f);
      ball.trail.push({ x, y });
      if (ball.trail.length > 7) ball.trail.shift();
      ball.trail.forEach((q, j) => {
        ctx.globalAlpha = ((j + 1) / ball.trail.length) * 0.35;
        ctx.beginPath();
        ctx.arc(q.x, q.y, BALL_R * 0.8, 0, Math.PI * 2);
        ctx.fillStyle = ball.color;
        ctx.fill();
      });
      ctx.globalAlpha = 1;
      ctx.beginPath();
      ctx.arc(x, y, BALL_R, 0, Math.PI * 2);
      ctx.fillStyle = ball.color;
      ctx.shadowColor = ball.color;
      ctx.shadowBlur = 14;
      ctx.fill();
      ctx.shadowBlur = 0;
    }
    for (let i = balls.length - 1; i >= 0; i--) if (balls[i].done) balls.splice(i, 1);
    // multiplier pop-ups
    for (let i = pops.length - 1; i >= 0; i--) {
      const q = pops[i];
      const age = (now - q.t0) / 1000;
      if (age > 1.2) {
        pops.splice(i, 1);
        continue;
      }
      ctx.globalAlpha = 1 - age / 1.2;
      ctx.fillStyle = q.color;
      ctx.font = `900 ${22 + age * 10}px Pretendard, 'Malgun Gothic', sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText(q.text, q.x, q.y - age * 50);
      ctx.globalAlpha = 1;
    }
    requestAnimationFrame(frame);
  }

  // A tab in the background pauses requestAnimationFrame: land those balls anyway so their results go out.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) for (const ball of balls) if (!ball.done) void ball.finish(ball.payout);
  });

  paintControls();
  const stakeObserver = new MutationObserver(paintControls);
  stakeObserver.observe(root.querySelector('[data-testid="stake"]')!, { childList: true, characterData: true, subtree: true });
  requestAnimationFrame(frame);
}

function slotColor(m: number): string {
  if (m >= 25) return '#ff2d6f';
  if (m >= 6) return '#ff7a1a';
  if (m >= 2) return '#ffc21a';
  if (m >= 1) return '#2ee87a';
  return '#26304f';
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
