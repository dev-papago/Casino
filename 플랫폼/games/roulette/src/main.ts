// 러시안 룰렛 (1대1): the player's side of a duel the server runs (src/server/roulette.ts). The lobby lists the
// rooms waiting for a second player and makes new ones. In a room the game asks the server for news a few times
// a second and plays every event out in order, with its motion and sound (the cylinder loaded, the coin, each
// shot); it sends only what the player chooses: shoot yourself or the other player, or give up.
import './style.css';
import * as casino from '../../../sdk/casino.ts';
import { PLATFORM } from '../../../src/shared/config.ts';
import type { RouletteEvent, RouletteRoomInfo, RouletteView } from '../../../src/shared/protocol.ts';
import { ago, h, requestKey, setText } from '../../../src/ui/dom.ts';
import { isMuted, setMuted, unlock } from '../../arcade/sound.ts';
import { REVOLVER_PIVOT, cylinderSvg, revolverSvg } from './gun.ts';
import { sfx } from './sfx.ts';

const R = PLATFORM.roulette;
const POLL_MS = 300; // news in a room
const LOBBY_MS = 1500; // the room list
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

type Shot = Extract<RouletteEvent, { kind: 'shot' }>;

// ------------------------------------------------------------------ the frame: title bar, rules, sound, exit

const app = document.getElementById('app')!;
document.addEventListener('pointerdown', unlock, { capture: true });
document.addEventListener('keydown', unlock, { capture: true });

const freeEl = h('b', { 'data-testid': 'rr-free' }, '…');
const muteBtn = h('button', { class: 'rr-icon', type: 'button', title: '소리', onclick: () => toggleMute() });
const rulesBox = h('div', { class: 'rr-rules', hidden: true }, rules());
const exitBtn = h('button', { class: 'rr-btn ghost', type: 'button', 'data-testid': 'rr-exit', onclick: () => void leave() }, '로비로');
const main = h('main', { class: 'rr-main' });
const toastEl = h('div', { class: 'rr-toast', hidden: true, role: 'status' });
app.append(
  h(
    'header',
    { class: 'rr-bar' },
    h('div', { class: 'rr-title' }, h('span', { class: 'rr-logo' }, '🔫'), '러시안 룰렛', h('small', {}, '1 : 1')),
    h('div', { class: 'rr-wallet' }, '보유 ', freeEl),
    h('button', { class: 'rr-icon', type: 'button', title: '규칙', onclick: () => (rulesBox.hidden = !rulesBox.hidden) }, '📖'),
    muteBtn,
    exitBtn,
  ),
  rulesBox,
  main,
  toastEl,
);
setText(muteBtn, isMuted() ? '🔇' : '🔊');

function toggleMute(): void {
  setMuted(!isMuted());
  setText(muteBtn, isMuted() ? '🔇' : '🔊');
}

function rules(): HTMLElement {
  return h(
    'ul',
    {},
    h('li', {}, '방을 만든 사람이 판돈(1칩 이상)과 목숨(1~5개)을 정하고, 같은 판돈을 건 상대가 들어오면 시작합니다.'),
    h('li', {}, `라운드마다 리볼버의 ${R.chambers}칸을 실탄과 빈탄으로 채웁니다. 몇 발씩인지는 알려 주지만 순서는 아무도 모릅니다.`),
    h('li', {}, '동전을 던져 먼저 쏠 사람을 정합니다.'),
    h('li', {}, `내 차례에는 ${R.turnMs / 1000}초 안에 나에게 쏠지, 상대에게 쏠지 고릅니다. 시간이 지나면 나에게 쏩니다.`),
    h('li', {}, '나에게 쏜 탄이 빈탄이면 차례가 유지되고, 실탄이면 목숨이 하나 줄고 차례가 넘어갑니다.'),
    h('li', {}, '상대에게 쏘면 결과(실탄이면 상대 목숨 −1)가 반영되고 차례가 넘어갑니다.'),
    h('li', {}, '탄창을 다 쓰면 다음 라운드에 새 탄창을 채웁니다. 목숨이 먼저 다 떨어지거나 기권·이탈한 쪽이 지고, 이긴 사람이 판돈을 모두 가져갑니다.'),
  );
}

let toastTimer = 0;
function toast(text: string, bad = false): void {
  setText(toastEl, text);
  toastEl.classList.toggle('bad', bad);
  toastEl.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (toastEl.hidden = true), 3200);
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : '오류가 났습니다');
const errCode = (e: unknown): string => (e instanceof casino.CasinoError ? e.code : '');

// ------------------------------------------------------------------ lobby: make a room, or join one

let screen: 'lobby' | 'room' = 'lobby';
let free = 0;
let stake = 1;
let lives = 3;
let lobbyTimer = 0;

function showLobby(note = ''): void {
  stopRoom();
  screen = 'lobby';
  const stakeInput = h('input', { class: 'rr-stake', type: 'number', min: 1, step: 1, value: stake, 'data-testid': 'rr-stake' });
  const setStake = (v: number): void => {
    stake = Math.max(1, Math.min(Math.max(1, free), Math.floor(v) || 1));
    stakeInput.value = String(stake);
  };
  stakeInput.addEventListener('change', () => setStake(Number(stakeInput.value)));
  const step = (d: number) => h('button', { class: 'rr-step', type: 'button', onclick: () => (setStake(stake + d), sfx.click()) }, d > 0 ? `+${d}` : `−${-d}`);
  const livesRow = h('div', { class: 'rr-lives-pick', role: 'radiogroup', 'aria-label': '목숨' });
  const drawLives = (): void =>
    livesRow.replaceChildren(
      ...Array.from({ length: R.maxLives }, (_, i) =>
        h(
          'button',
          { class: `rr-heart-pick${i < lives ? ' on' : ''}`, type: 'button', 'aria-label': `목숨 ${i + 1}개`, 'data-testid': `rr-lives-${i + 1}`, onclick: () => ((lives = i + 1), sfx.click(), drawLives()) },
          '♥',
        ),
      ),
      h('span', { class: 'rr-lives-n' }, `${lives}개`),
    );
  drawLives();
  const createBtn = h('button', { class: 'rr-btn gold big', type: 'button', 'data-testid': 'rr-create' }, '방 만들기');
  const msg = h('p', { class: 'rr-msg', 'data-testid': 'rr-lobby-msg' }, note);
  createBtn.addEventListener('click', () =>
    void (async () => {
      setStake(Number(stakeInput.value));
      createBtn.disabled = true;
      try {
        const v = await casino.request<RouletteView>('roulette/create', { stake, lives, key: requestKey() });
        sfx.click();
        enterRoom(v.id, v);
      } catch (e) {
        sfx.error();
        setText(msg, errText(e));
        if (errCode(e) === 'roulette_busy') void refreshLobby();
      } finally {
        createBtn.disabled = false;
      }
    })(),
  );
  const list = h('ul', { class: 'rr-rooms', 'data-testid': 'rr-rooms' });
  main.replaceChildren(
    h(
      'section',
      { class: 'rr-lobby' },
      h(
        'div',
        { class: 'rr-card create' },
        h('div', { class: 'rr-card-gun' }),
        h('h2', {}, '방 만들기'),
        h('label', { class: 'rr-field' }, h('span', {}, '판돈'), h('div', { class: 'rr-stepper' }, step(-5), step(-1), stakeInput, step(1), step(5)), h('small', {}, '상대도 같은 칩을 겁니다 · 이기면 두 배')),
        h('div', { class: 'rr-field' }, h('span', {}, '목숨'), livesRow),
        createBtn,
        msg,
      ),
      h('div', { class: 'rr-card rooms' }, h('h2', {}, '참여할 수 있는 방'), list),
    ),
  );
  main.querySelector('.rr-card-gun')!.innerHTML = revolverSvg;
  void refreshLobby(list);
  window.clearInterval(lobbyTimer);
  lobbyTimer = window.setInterval(() => void refreshLobby(list), LOBBY_MS);
}

async function refreshLobby(list = main.querySelector<HTMLUListElement>('.rr-rooms')): Promise<void> {
  let r: { rooms: RouletteRoomInfo[]; mine: string | null; free: number };
  try {
    r = await casino.request('roulette/rooms', {}, 0);
  } catch (e) {
    if (errCode(e) === 'session') return showFatal('로그인이 끝났습니다. 로비에서 다시 로그인하세요');
    return;
  }
  free = r.free;
  setText(freeEl, `${free}칩`);
  if (screen !== 'lobby') return;
  if (r.mine) return enterRoom(r.mine); // a room of mine is still going (a reload): back into it
  if (!list) return;
  const rooms = r.rooms.filter((x) => !x.mine);
  list.replaceChildren(
    ...(rooms.length
      ? rooms.map((x) =>
          h(
            'li',
            { class: 'rr-room', 'data-testid': 'rr-room' },
            h('div', { class: 'rr-room-host' }, h('b', {}, x.host), h('small', {}, ago(x.createdAt))),
            h('div', { class: 'rr-room-stake' }, h('span', {}, '판돈'), h('b', {}, `${x.stake}칩`)),
            h('div', { class: 'rr-room-lives', title: `목숨 ${x.lives}개` }, '♥'.repeat(x.lives)),
            h(
              'button',
              { class: 'rr-btn gold', type: 'button', disabled: free < x.stake, 'data-testid': 'rr-join', onclick: () => void join(x) },
              free < x.stake ? '칩 부족' : '참여',
            ),
          ),
        )
      : [h('li', { class: 'rr-empty' }, '기다리는 방이 없습니다. 방을 만들어 상대를 기다려 보세요.')]),
  );
}

async function join(x: RouletteRoomInfo): Promise<void> {
  try {
    const v = await casino.request<RouletteView>('roulette/join', { room: x.id, key: requestKey() });
    sfx.click();
    enterRoom(v.id, v);
  } catch (e) {
    sfx.error();
    toast(errText(e), true);
    void refreshLobby();
  }
}

function showFatal(text: string): void {
  stopRoom();
  window.clearInterval(lobbyTimer);
  main.replaceChildren(h('div', { class: 'rr-fatal' }, h('p', {}, text), h('button', { class: 'rr-btn', type: 'button', onclick: () => casino.exit() }, '로비로')));
}

// ------------------------------------------------------------------ the table

interface Table {
  root: HTMLElement;
  seat: HTMLElement[]; // [me, opponent]
  names: HTMLElement[];
  hearts: HTMLElement[];
  round: HTMLElement;
  ammo: HTMLElement;
  ammoText: HTMLElement;
  gun: HTMLElement;
  cyl: HTMLElement;
  status: HTMLElement;
  stamp: HTMLElement;
  timer: HTMLElement;
  timerArc: SVGCircleElement;
  timerText: HTMLElement;
  selfBtn: HTMLButtonElement;
  otherBtn: HTMLButtonElement;
  forfeitBtn: HTMLButtonElement;
  overlay: HTMLElement;
  flash: HTMLElement;
}

let roomId: string | null = null;
let after = 0; // the last event played (or queued)
let view: RouletteView | null = null;
let queue: RouletteEvent[] = [];
let animating = false;
let deadline = 0; // the turn's end, on this PC's clock
let sending = false;
let t: Table | null = null;
let shown = { lives: [0, 0], left: { live: 0, blank: 0 }, fired: 0, round: 0, turn: -1, names: ['', ''] };
let gunAngle = 0;
let endShown = false;
let lastBeat = -1;
let rafId = 0;

/** Seat number (0: creator, 1: guest) → 0 for me, 1 for the opponent. */
const side = (seat: number): number => (view && seat === view.me ? 0 : 1);
const seatName = (seat: number): string => shown.names[seat] || view?.seats[seat]?.name || '상대';

function enterRoom(id: string, first?: RouletteView): void {
  window.clearInterval(lobbyTimer);
  stopRoom();
  screen = 'room';
  roomId = id;
  after = 0;
  queue = [];
  endShown = false;
  gunAngle = 0;
  shown = { lives: [0, 0], left: { live: 0, blank: 0 }, fired: 0, round: 0, turn: -1, names: ['', ''] };
  t = buildTable();
  main.replaceChildren(t.root);
  if (first) take(first, false);
  void poll(id, !first);
  cancelAnimationFrame(rafId);
  rafId = requestAnimationFrame(frame);
}

function stopRoom(): void {
  roomId = null;
  view = null;
  queue = [];
  t = null;
}

function buildTable(): Table {
  const hearts = [h('div', { class: 'rr-hearts', 'data-testid': 'rr-my-lives' }), h('div', { class: 'rr-hearts', 'data-testid': 'rr-their-lives' })];
  const names = [h('b', { class: 'rr-name' }), h('b', { class: 'rr-name' })];
  const seat = [
    h('div', { class: 'rr-seat me' }, h('span', { class: 'rr-seat-tag' }, '나'), names[0], hearts[0]),
    h('div', { class: 'rr-seat opp' }, h('span', { class: 'rr-seat-tag' }, '상대'), names[1], hearts[1]),
  ];
  const gun = h('div', { class: 'rr-gun' });
  gun.innerHTML = revolverSvg;
  gun.style.transformOrigin = `${(REVOLVER_PIVOT.x / REVOLVER_PIVOT.w) * 100}% ${(REVOLVER_PIVOT.y / REVOLVER_PIVOT.h) * 100}%`;
  const cyl = h('div', { class: 'rr-cyl' });
  cyl.innerHTML = cylinderSvg(R.chambers);
  const timerSvgWrap = h('div', { class: 'rr-timer-ring' });
  timerSvgWrap.innerHTML = '<svg viewBox="0 0 100 100"><circle class="bg" cx="50" cy="50" r="44"/><circle class="arc" cx="50" cy="50" r="44"/></svg>';
  const timerText = h('b', { class: 'rr-timer-n' });
  const timer = h('div', { class: 'rr-timer', hidden: true, 'data-testid': 'rr-timer' }, timerSvgWrap, timerText);
  const selfBtn = h('button', { class: 'rr-shoot self', type: 'button', disabled: true, 'data-testid': 'rr-shoot-self' }, h('span', { class: 'rr-shoot-icon' }, '🫵'), '나에게 쏘기', h('small', {}, '빈탄이면 한 번 더'));
  const otherBtn = h('button', { class: 'rr-shoot other', type: 'button', disabled: true, 'data-testid': 'rr-shoot-other' }, h('span', { class: 'rr-shoot-icon' }, '🎯'), '상대에게 쏘기', h('small', {}, '쏘고 나면 차례가 넘어감'));
  selfBtn.addEventListener('click', () => void shoot('self'));
  otherBtn.addEventListener('click', () => void shoot('other'));
  const forfeitBtn = h('button', { class: 'rr-btn ghost small', type: 'button', 'data-testid': 'rr-forfeit' }, '기권');
  forfeitBtn.addEventListener('click', () => void forfeit());
  const round = h('div', { class: 'rr-round', 'data-testid': 'rr-round' }, 'ROUND —');
  const ammo = h('div', { class: 'rr-ammo' });
  const ammoText = h('div', { class: 'rr-ammo-text', 'data-testid': 'rr-ammo' });
  const status = h('div', { class: 'rr-status', 'data-testid': 'rr-status' });
  const stamp = h('div', { class: 'rr-stamp' });
  const overlay = h('div', { class: 'rr-overlay', hidden: true });
  const flash = h('div', { class: 'rr-flash' });
  const timerArc = timerSvgWrap.querySelector<SVGCircleElement>('.arc')!;
  const root = h(
    'section',
    { class: 'rr-table' },
    seat[1],
    h(
      'div',
      { class: 'rr-felt' },
      h('div', { class: 'rr-felt-top' }, round, h('div', { class: 'rr-ammo-box' }, ammo, ammoText)),
      h('div', { class: 'rr-stage' }, gun, cyl, stamp),
      status,
      timer,
    ),
    seat[0],
    h('div', { class: 'rr-actions' }, selfBtn, otherBtn),
    h('div', { class: 'rr-foot' }, forfeitBtn),
    flash,
    overlay,
  );
  return { root, seat, names, hearts, round, ammo, ammoText, gun, cyl, status, stamp, timer, timerArc, timerText, selfBtn, otherBtn, forfeitBtn, overlay, flash };
}

// ------------------------------------------------------------------ news from the server

/** Asks for news until the room is left. On a return to a running room (`catchUp`) the past plays at once. */
async function poll(id: string, catchUp: boolean): Promise<void> {
  let fails = 0;
  while (roomId === id) {
    try {
      const v = await casino.request<RouletteView>('roulette/state', { room: id, after }, 0);
      if (roomId !== id) return;
      fails = 0;
      take(v, catchUp);
      catchUp = false;
    } catch (e) {
      if (roomId !== id) return;
      const code = errCode(e);
      if (code === 'gone' || code === 'forbidden') return showLobby('방이 사라졌습니다');
      if (code === 'session') return showFatal('로그인이 끝났습니다. 로비에서 다시 로그인하세요');
      if (++fails === 3) toast('서버와 연결이 불안정합니다 · 다시 연결하는 중…', true);
    }
    await sleep(POLL_MS);
  }
}

function take(v: RouletteView, instant: boolean): void {
  view = v;
  const fresh = v.events.filter((e) => e.n > after);
  if (fresh.length) after = v.last;
  if (v.phase === 'turn') deadline = performance.now() + v.msLeft;
  if (instant) {
    for (const e of fresh) apply(e);
  } else queue.push(...fresh);
  void drain();
  if (!animating) settle();
}

async function drain(): Promise<void> {
  if (animating) return;
  animating = true;
  while (queue.length && t) {
    const e = queue.shift()!;
    const fast = queue.length > 2 || document.hidden; // fallen behind: catch up without the show
    try {
      await play(e, fast);
    } catch (err) {
      console.error(err);
      apply(e);
    }
  }
  animating = false;
  settle();
}

/** The state an event leaves behind, without the show. */
function apply(e: RouletteEvent): void {
  if (!t) return;
  switch (e.kind) {
    case 'start':
      shown.names = e.names;
      shown.lives = [e.lives, e.lives];
      break;
    case 'load':
      shown.round = e.round;
      shown.left = { live: e.live, blank: e.blank };
      shown.fired = 0;
      resetCylinder();
      break;
    case 'coin':
      shown.turn = e.first;
      break;
    case 'turn':
      shown.turn = e.seat;
      break;
    case 'shot':
      shown.lives = e.lives;
      shown.left = e.left;
      markChamber(e.live);
      shown.fired++;
      setCylinderTurn(shown.fired);
      break;
    case 'end':
      showEnd(e);
      break;
  }
  paint();
}

/** Lives, names, round, the rounds left, whose turn: from what has been played so far. */
function paint(): void {
  if (!t || !view) return;
  const me = view.me;
  for (const seat of [0, 1]) {
    if (seat >= Math.max(view.seats.length, shown.names.filter(Boolean).length)) continue;
    const s = side(seat);
    setText(t.names[s], seatName(seat));
    drawHearts(t.hearts[s], shown.lives[seat] ?? view.lives, view.lives);
    t.seat[s].classList.toggle('turn', shown.turn === seat && view.phase !== 'over' && view.phase !== 'waiting');
  }
  if (view.seats.length < 2) setText(t.names[1], '???');
  setText(t.round, shown.round ? `ROUND ${shown.round}` : 'ROUND —');
  drawAmmo(shown.left);
  t.root.classList.toggle('my-turn', shown.turn === me && view.phase === 'turn' && !animating);
}

/** After the shows: the state as the server has it now (the buttons, the status, the waiting room). */
function settle(): void {
  if (!t || !view) return;
  const v = view;
  if (!queue.length && !animating) {
    shown.lives = v.seats.map((s) => s.lives);
    shown.left = v.left;
    if (v.phase !== 'waiting' && v.phase !== 'over') shown.turn = v.turn;
  }
  paint();
  const myTurn = v.phase === 'turn' && v.turn === v.me && !animating && !queue.length;
  t.selfBtn.disabled = t.otherBtn.disabled = !myTurn || sending;
  t.forfeitBtn.hidden = v.phase === 'over';
  t.timer.hidden = v.phase !== 'turn' || animating;
  if (v.phase === 'waiting') return showWaiting(v);
  if (t.overlay.dataset.kind === 'waiting') hideOverlay();
  if (v.phase === 'over' && !endShown && !queue.length && !animating) {
    const end = { n: 0, kind: 'end', winner: v.winner, reason: v.reason ?? 'refund', payout: v.winner === null ? v.stake : v.stake * 2 } as const;
    showEnd(end);
  }
  if (!animating && v.phase === 'turn') setText(t.status, v.turn === v.me ? '내 차례 · 누구에게 쏠까?' : `${seatName(v.turn)}의 차례…`);
}

// ------------------------------------------------------------------ the shows

async function play(e: RouletteEvent, fast: boolean): Promise<void> {
  if (!t) return;
  const wait = (ms: number): Promise<void> => (fast ? Promise.resolve() : sleep(ms));
  switch (e.kind) {
    case 'start': {
      apply(e);
      if (fast) return;
      hideOverlay();
      sfx.start();
      await banner('DUEL', `${e.names[0]}  vs  ${e.names[1]}`, `판돈 ${e.stake}칩씩 · 승자 ${e.stake * 2}칩`, 1500);
      return;
    }
    case 'load': {
      shown.round = e.round;
      paint();
      if (fast) return apply(e);
      sfx.round();
      t.round.animate([{ transform: 'scale(1.6)', color: '#ffd34d' }, { transform: 'scale(1)' }], { duration: 600, easing: 'cubic-bezier(.2,1.6,.4,1)' });
      setText(t.status, `ROUND ${e.round} · 탄창을 채웁니다`);
      await loadShow(e.live, e.blank);
      apply(e);
      return;
    }
    case 'coin': {
      if (fast) return apply(e);
      await coinShow(e.first);
      apply(e);
      return;
    }
    case 'turn': {
      apply(e);
      if (fast) return;
      const mine = view && e.seat === view.me;
      if (mine) sfx.turn();
      setText(t.status, mine ? '내 차례 · 누구에게 쏠까?' : `${seatName(e.seat)}의 차례…`);
      t.seat[side(e.seat)].animate([{ transform: 'scale(1.06)' }, { transform: 'scale(1)' }], { duration: 400 });
      await wait(200);
      return;
    }
    case 'shot':
      return shotShow(e, fast);
    case 'end':
      apply(e);
      return;
  }
}

async function banner(title: string, line: string, sub: string, ms: number): Promise<void> {
  if (!t) return;
  showOverlay('banner', h('div', { class: 'rr-banner' }, h('div', { class: 'rr-banner-title' }, title), h('div', { class: 'rr-banner-line' }, line), h('div', { class: 'rr-banner-sub' }, sub)));
  await sleep(ms);
  hideOverlay();
}

/** The new cylinder: the rounds laid out (live red, blank grey), then loaded and the cylinder spun. */
async function loadShow(live: number, blank: number): Promise<void> {
  if (!t) return;
  const shells = [...Array(live).fill(true), ...Array(blank).fill(false)].map((l) => h('div', { class: `rr-shell big ${l ? 'live' : 'blank'}` }));
  const row = h('div', { class: 'rr-load-row' }, ...shells);
  showOverlay(
    'load',
    h(
      'div',
      { class: 'rr-load' },
      h('div', { class: 'rr-load-title' }, `ROUND ${shown.round}`),
      row,
      h('div', { class: 'rr-load-count' }, h('span', { class: 'live' }, `실탄 ${live}`), ' · ', h('span', { class: 'blank' }, `빈탄 ${blank}`)),
    ),
  );
  for (const [i, s] of shells.entries()) {
    s.animate([{ transform: 'translateY(-60px) rotate(-30deg)', opacity: 0 }, { transform: 'translateY(6px)', opacity: 1, offset: 0.7 }, { transform: 'none', opacity: 1 }], {
      duration: 380,
      delay: i * 130,
      easing: 'ease-out',
      fill: 'backwards',
    });
    window.setTimeout(() => sfx.shell(i), i * 130 + 250);
  }
  await sleep(shells.length * 130 + 700);
  // Mixed up and loaded: the order is secret.
  row.animate([{ transform: 'none' }, { transform: 'translateX(-8px)' }, { transform: 'translateX(8px)' }, { transform: 'none' }], { duration: 300, iterations: 2 });
  await sleep(500);
  for (const [i, s] of shells.entries()) s.animate([{ transform: 'none', opacity: 1 }, { transform: 'translateY(120px) scale(.3)', opacity: 0 }], { duration: 380, delay: i * 40, easing: 'ease-in', fill: 'forwards' });
  await sleep(420);
  hideOverlay();
  resetCylinder();
  sfx.spin(1.1);
  await spin(t.cyl.querySelector('.cyl-rot')!, 0, 720 + 360, 1100);
  shown.left = { live, blank };
  paint();
}

/** The coin: front is the room's creator, back the guest; it lands on whoever starts. */
async function coinShow(first: number): Promise<void> {
  if (!t) return;
  const coin = h(
    'div',
    { class: 'rr-coin' },
    h('div', { class: 'rr-coin-face front' }, h('span', {}, initial(seatName(0))), h('small', {}, seatName(0))),
    h('div', { class: 'rr-coin-face back' }, h('span', {}, initial(seatName(1))), h('small', {}, seatName(1))),
  );
  const result = h('div', { class: 'rr-coin-result' });
  showOverlay('coin', h('div', { class: 'rr-coin-stage' }, h('div', { class: 'rr-coin-title' }, '동전 던지기 · 먼저 쏠 사람'), coin, h('div', { class: 'rr-coin-shadow' }), result));
  const turns = 1800 + (first === 1 ? 180 : 0);
  sfx.coin(2.1);
  await coin
    .animate(
      [
        { transform: 'translateY(0) rotateY(0deg) scale(1)' },
        { transform: `translateY(-150px) rotateY(${turns * 0.5}deg) scale(1.15)`, offset: 0.45 },
        { transform: `translateY(0) rotateY(${turns - 25}deg) scale(1)`, offset: 0.9 },
        { transform: `translateY(0) rotateY(${turns}deg) scale(1)` },
      ],
      { duration: 2100, easing: 'cubic-bezier(.25,.6,.35,1)', fill: 'forwards' },
    )
    .finished.catch(() => {});
  const mine = view && first === view.me;
  setText(result, mine ? '내가 먼저!' : `${seatName(first)} 먼저!`);
  result.classList.add(mine ? 'me' : 'opp');
  result.animate([{ transform: 'scale(.4)', opacity: 0 }, { transform: 'scale(1.15)', opacity: 1, offset: 0.6 }, { transform: 'scale(1)', opacity: 1 }], { duration: 450, fill: 'forwards' });
  await sleep(900);
  hideOverlay();
}

/** One shot: the gun turns to the target, the hammer, a heartbeat, then the round goes off (or does not). */
async function shotShow(e: Shot, fast: boolean): Promise<void> {
  if (!t || !view) return;
  t.timer.hidden = true;
  t.selfBtn.disabled = t.otherBtn.disabled = true;
  t.root.classList.remove('my-turn');
  const toMe = side(e.target) === 0;
  const atSelf = e.target === e.shooter;
  const who = view && e.shooter === view.me ? '나' : seatName(e.shooter);
  if (fast) return apply(e);
  setText(t.status, `${e.auto ? '⏱ 시간 초과 · ' : ''}${who} → ${atSelf ? (e.shooter === view.me ? '나 자신' : '자기 자신') : e.shooter === view.me ? '상대' : '나'}`);
  sfx.cock();
  await aim(toMe ? 90 : -90, 420);
  t.gun.classList.add('cocked');
  await sleep(250);
  sfx.heart(0.55);
  t.root.classList.add('suspense');
  await sleep(700);
  t.root.classList.remove('suspense');
  t.gun.classList.remove('cocked');
  if (e.live) {
    sfx.bang();
    fire(t.gun, true);
    shake(t.root, 520);
    t.flash.animate([{ opacity: 0.85 }, { opacity: 0 }], { duration: 650, easing: 'ease-out' });
    stamp('실탄!', 'live');
    window.setTimeout(() => sfx.hurt(), 160);
    hit(side(e.target));
  } else {
    sfx.dry();
    fire(t.gun, false);
    stamp(atSelf ? '빈탄 · 한 번 더!' : '빈탄', 'blank');
  }
  markChamber(e.live);
  shown.lives = e.lives;
  shown.left = e.left;
  paint();
  await sleep(750);
  shown.fired++;
  sfx.tick();
  await setCylinderTurn(shown.fired, 300);
  await aim(0, 380);
}

/** The gun turns to `deg` (0: lying to the right, 90: at me, −90: at the opponent). */
async function aim(deg: number, ms: number): Promise<void> {
  if (!t) return;
  const from = gunAngle;
  gunAngle = deg;
  await anim(t.gun, [{ transform: `rotate(${from}deg)` }, { transform: `rotate(${deg}deg)` }], { duration: ms, easing: 'cubic-bezier(.3,1.3,.5,1)' });
}

function fire(gun: HTMLElement, live: boolean): void {
  const flash = gun.querySelector('.rv-flash')!;
  const smoke = gun.querySelector('.rv-smoke')!;
  const hammer = gun.querySelector('.rv-hammer')!;
  hammer.animate([{ transform: 'rotate(-14deg)' }, { transform: 'rotate(4deg)' }, { transform: 'none' }], { duration: 160 });
  if (live) {
    flash.animate([{ opacity: 0, transform: 'translate(372px,66px) scale(.2)' }, { opacity: 1, transform: 'translate(372px,66px) scale(1.25)', offset: 0.25 }, { opacity: 0, transform: 'translate(372px,66px) scale(.8)' }], { duration: 260 });
    gun.animate([{ translate: '0 0' }, { translate: '-14px 0' }, { translate: '0 0' }], { duration: 260, composite: 'add' });
  }
  smoke.animate(
    [
      { opacity: live ? 0.9 : 0.35, transform: 'translate(372px,66px) scale(.4)' },
      { opacity: 0, transform: `translate(${live ? 410 : 385}px,${live ? 40 : 58}px) scale(${live ? 2.4 : 1.2})` },
    ],
    { duration: live ? 1200 : 600, easing: 'ease-out' },
  );
}

function shake(el: HTMLElement, ms: number): void {
  const k = Array.from({ length: 9 }, (_, i) => ({ transform: i === 8 ? 'none' : `translate(${(Math.random() - 0.5) * 22}px, ${(Math.random() - 0.5) * 16}px)` }));
  el.animate(k, { duration: ms, easing: 'linear' });
}

function stamp(text: string, kind: 'live' | 'blank'): void {
  if (!t) return;
  setText(t.stamp, text);
  t.stamp.className = `rr-stamp ${kind}`;
  t.stamp.animate(
    [
      { opacity: 0, transform: 'translate(-50%,-50%) scale(2.4) rotate(-12deg)' },
      { opacity: 1, transform: 'translate(-50%,-50%) scale(1) rotate(-8deg)', offset: 0.18 },
      { opacity: 1, transform: 'translate(-50%,-50%) scale(1) rotate(-8deg)', offset: 0.8 },
      { opacity: 0, transform: 'translate(-50%,-50%) scale(1.05) rotate(-8deg)' },
    ],
    { duration: 1500, easing: 'ease-out' },
  );
}

/** The hit seat flinches and its last heart breaks. */
function hit(s: number): void {
  if (!t) return;
  t.seat[s].animate([{ background: 'rgba(255,40,60,.55)' }, { background: 'transparent' }], { duration: 900 });
  const full = t.hearts[s].querySelectorAll('.rr-heart.on');
  const last = full[full.length - 1];
  if (last) {
    const ghost = last.cloneNode(true) as HTMLElement;
    ghost.classList.add('ghost');
    last.after(ghost);
    ghost
      .animate([{ transform: 'scale(1)', opacity: 1 }, { transform: 'scale(1.8) rotate(-25deg)', opacity: 1, offset: 0.25 }, { transform: 'translateY(40px) rotate(-60deg) scale(.6)', opacity: 0 }], { duration: 900, easing: 'ease-in' })
      .finished.then(() => ghost.remove(), () => ghost.remove());
  }
}

// ------------------------------------------------------------------ the cylinder and the rounds left

function resetCylinder(): void {
  if (!t) return;
  for (const c of t.cyl.querySelectorAll('.cyl-chamber')) c.setAttribute('class', 'cyl-chamber loaded');
  setCylinderTurn(0, 0);
}

function markChamber(live: boolean): void {
  if (!t) return;
  const c = t.cyl.querySelector(`.cyl-chamber[data-i="${shown.fired % R.chambers}"]`);
  c?.setAttribute('class', `cyl-chamber ${live ? 'fired-live' : 'fired-blank'}`);
}

/** Turns the cylinder so the next chamber is at the top. */
async function setCylinderTurn(fired: number, ms = 0): Promise<void> {
  if (!t) return;
  const g = t.cyl.querySelector<SVGGElement>('.cyl-rot')!;
  const to = (-fired * 360) / R.chambers;
  const from = Number(g.dataset.deg ?? 0);
  g.dataset.deg = String(to);
  if (!ms) {
    g.style.transform = `rotate(${to}deg)`;
    return;
  }
  await spin(g, from, to, ms);
}

async function spin(el: Element, from: number, to: number, ms: number): Promise<void> {
  const g = el as SVGGElement;
  const a = g.animate([{ transform: `rotate(${from}deg)` }, { transform: `rotate(${to}deg)` }], { duration: ms, easing: 'cubic-bezier(.15,.7,.3,1)', fill: 'forwards' });
  await a.finished.catch(() => {});
  g.style.transform = `rotate(${to % 360}deg)`;
  g.dataset.deg = String(to % 360);
  a.cancel();
}

function drawAmmo(left: { live: number; blank: number }): void {
  if (!t) return;
  const want = `${left.live}/${left.blank}`;
  if (t.ammo.dataset.v === want) return;
  t.ammo.dataset.v = want;
  t.ammo.replaceChildren(
    ...Array.from({ length: left.live }, () => h('div', { class: 'rr-shell live' })),
    ...Array.from({ length: left.blank }, () => h('div', { class: 'rr-shell blank' })),
  );
  setText(t.ammoText, left.live + left.blank ? `실탄 ${left.live} · 빈탄 ${left.blank}` : '탄창 비었음');
}

function drawHearts(el: HTMLElement, n: number, of: number): void {
  const want = `${n}/${of}`;
  if (el.dataset.v === want) return;
  el.dataset.v = want;
  el.replaceChildren(...Array.from({ length: of }, (_, i) => h('span', { class: `rr-heart${i < n ? ' on' : ''}` }, i < n ? '♥' : '♡')));
}

const initial = (name: string): string => [...name][0] ?? '?';

// ------------------------------------------------------------------ overlays: waiting, the end

function showOverlay(kind: string, ...children: HTMLElement[]): void {
  if (!t) return;
  t.overlay.dataset.kind = kind;
  t.overlay.replaceChildren(...children);
  t.overlay.hidden = false;
  t.overlay.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200 });
}

function hideOverlay(): void {
  if (!t) return;
  t.overlay.hidden = true;
  t.overlay.dataset.kind = '';
  t.overlay.replaceChildren();
}

function showWaiting(v: RouletteView): void {
  if (!t || t.overlay.dataset.kind === 'waiting') return;
  const cyl = h('div', { class: 'rr-wait-cyl' });
  cyl.innerHTML = cylinderSvg(R.chambers);
  const cancel = h('button', { class: 'rr-btn', type: 'button', 'data-testid': 'rr-cancel' }, '방 취소 (판돈 돌려받기)');
  cancel.addEventListener('click', () =>
    void (async () => {
      cancel.disabled = true;
      try {
        await casino.request('roulette/cancel', { room: v.id });
        sfx.click();
        showLobby('방을 취소했습니다. 판돈을 돌려받았습니다');
      } catch (e) {
        cancel.disabled = false;
        toast(errText(e), true);
      }
    })(),
  );
  showOverlay(
    'waiting',
    h(
      'div',
      { class: 'rr-wait', 'data-testid': 'rr-waiting' },
      cyl,
      h('div', { class: 'rr-wait-title' }, '상대를 기다리는 중'),
      h('div', { class: 'rr-wait-dots' }, h('i'), h('i'), h('i')),
      h('div', { class: 'rr-wait-info' }, `판돈 ${v.stake}칩 · 목숨 ${'♥'.repeat(v.lives)}`),
      h('p', { class: 'rr-wait-note' }, '같은 판돈을 건 상대가 들어오면 바로 시작합니다.'),
      cancel,
    ),
  );
}

function showEnd(e: Extract<RouletteEvent, { kind: 'end' }>): void {
  if (!t || !view || endShown) return;
  endShown = true;
  t.selfBtn.disabled = t.otherBtn.disabled = true;
  t.timer.hidden = true;
  const me = view.me;
  const won = e.winner === me;
  const refund = e.winner === null;
  const loser = e.winner === null ? null : 1 - e.winner;
  const why =
    refund
      ? '판돈을 돌려받았습니다'
      : e.reason === 'forfeit'
        ? `${loser === me ? '내가' : `${seatName(loser!)}이(가)`} 기권했습니다`
        : e.reason === 'left'
          ? `${loser === me ? '내' : `${seatName(loser!)}의`} 연결이 끊겼습니다`
          : `${loser === me ? '내' : `${seatName(loser!)}의`} 목숨이 모두 사라졌습니다`;
  const title = refund ? '대결 취소' : won ? '승리' : '패배';
  const amount = refund ? `${view.stake}칩 반환` : won ? `+${view.stake}칩 (판돈 ${e.payout}칩 획득)` : `−${view.stake}칩`;
  if (!refund) (won ? sfx.win : sfx.lose)();
  const card = h(
    'div',
    { class: `rr-end ${refund ? 'refund' : won ? 'won' : 'lost'}`, 'data-testid': 'rr-end' },
    h('div', { class: 'rr-end-title' }, title),
    h('div', { class: 'rr-end-amount' }, amount),
    h('div', { class: 'rr-end-why' }, why),
    h(
      'div',
      { class: 'rr-end-actions' },
      h('button', { class: 'rr-btn gold', type: 'button', 'data-testid': 'rr-again', onclick: () => showLobby() }, '방 목록으로'),
      h('button', { class: 'rr-btn ghost', type: 'button', onclick: () => casino.exit() }, '로비로'),
    ),
  );
  showOverlay('end', card);
  card.animate([{ transform: 'scale(.6) translateY(30px)', opacity: 0 }, { transform: 'scale(1.05)', opacity: 1, offset: 0.7 }, { transform: 'none', opacity: 1 }], { duration: 600, easing: 'ease-out' });
  if (won) confetti(t.overlay);
  void refreshFree();
}

function confetti(el: HTMLElement): void {
  for (let i = 0; i < 40; i++) {
    const c = h('i', { class: 'rr-confetti' });
    c.style.left = `${Math.random() * 100}%`;
    c.style.background = ['#ffd34d', '#ff4d6d', '#3dff8f', '#39e0ff', '#fff'][i % 5];
    el.append(c);
    c.animate([{ transform: 'translateY(-20px) rotate(0)', opacity: 1 }, { transform: `translateY(${300 + Math.random() * 300}px) rotate(${Math.random() * 720}deg)`, opacity: 0 }], {
      duration: 1600 + Math.random() * 1200,
      delay: Math.random() * 400,
      easing: 'cubic-bezier(.2,.6,.4,1)',
      fill: 'forwards',
    });
  }
}

async function refreshFree(): Promise<void> {
  try {
    free = (await casino.player()).free;
    setText(freeEl, `${free}칩`);
  } catch {
    // shown again on the room list
  }
}

// ------------------------------------------------------------------ what the player does

async function shoot(target: 'self' | 'other'): Promise<void> {
  if (!t || !view || !roomId || sending) return;
  sending = true;
  t.selfBtn.disabled = t.otherBtn.disabled = true;
  sfx.click();
  try {
    const v = await casino.request<RouletteView>('roulette/shoot', { room: roomId, target });
    take(v, false);
  } catch (e) {
    sfx.error();
    toast(errText(e), true);
  } finally {
    sending = false;
    settle();
  }
}

async function forfeit(): Promise<void> {
  if (!roomId || !view || view.phase === 'over') return;
  if (view.phase === 'waiting') return showWaiting(view);
  if (!(await confirmBox('기권할까요?', `판돈 ${view.stake}칩은 상대가 가져갑니다.`, '기권'))) return;
  try {
    await casino.request('roulette/forfeit', { room: roomId });
  } catch (e) {
    toast(errText(e), true);
  }
}

/** 로비로: a waiting room is called off (stake back); a game running is given up first. */
async function leave(): Promise<void> {
  if (screen === 'room' && roomId && view && view.phase !== 'over') {
    if (view.phase === 'waiting') {
      await casino.request('roulette/cancel', { room: roomId }).catch(() => {});
    } else {
      if (!(await confirmBox('나가면 기권입니다', `판돈 ${view.stake}칩은 상대가 가져갑니다. 나갈까요?`, '기권하고 나가기'))) return;
      await casino.request('roulette/forfeit', { room: roomId }).catch(() => {});
    }
  }
  casino.exit();
}

function confirmBox(title: string, text: string, ok: string): Promise<boolean> {
  return new Promise((resolve) => {
    const done = (v: boolean): void => {
      box.remove();
      resolve(v);
    };
    const box = h(
      'div',
      { class: 'rr-confirm' },
      h(
        'div',
        { class: 'rr-confirm-card' },
        h('h3', {}, title),
        h('p', {}, text),
        h(
          'div',
          { class: 'rr-end-actions' },
          h('button', { class: 'rr-btn ghost', type: 'button', onclick: () => done(false) }, '취소'),
          h('button', { class: 'rr-btn danger', type: 'button', 'data-testid': 'rr-confirm-ok', onclick: () => done(true) }, ok),
        ),
      ),
    );
    document.body.append(box);
  });
}

// ------------------------------------------------------------------ the turn clock

function frame(): void {
  if (!t || screen !== 'room') return;
  const v = view;
  if (v && v.phase === 'turn' && !animating && !queue.length) {
    const left = Math.max(0, deadline - performance.now());
    const frac = left / R.turnMs;
    t.timer.hidden = false;
    const c = 2 * Math.PI * 44;
    t.timerArc.style.strokeDasharray = `${c}`;
    t.timerArc.style.strokeDashoffset = `${c * (1 - frac)}`;
    t.timer.classList.toggle('hot', left < 4000);
    const sec = Math.ceil(left / 1000);
    setText(t.timerText, String(sec));
    if (sec !== lastBeat && sec > 0) {
      lastBeat = sec;
      if (sec <= 5) (v.turn === v.me ? sfx.heart(0.35 + (5 - sec) * 0.08) : sfx.tick());
    }
  } else lastBeat = -1;
  rafId = requestAnimationFrame(frame);
}

/** Waits for a WAAPI animation and keeps where it ended. */
async function anim(el: HTMLElement, frames: Keyframe[], o: KeyframeAnimationOptions): Promise<void> {
  const a = el.animate(frames, { ...o, fill: 'forwards' });
  await a.finished.catch(() => {});
  try {
    a.commitStyles();
  } catch {
    // the element left the page
  }
  a.cancel();
}

// ------------------------------------------------------------------ boot

if (!casino.inCasino()) {
  main.replaceChildren(h('div', { class: 'rr-fatal' }, h('p', {}, '러시안 룰렛은 카지노 플레이어 앱에서 로그인한 뒤 열어 주세요.')));
  exitBtn.hidden = true;
} else {
  showLobby();
}
