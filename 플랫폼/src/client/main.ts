// Player app: 로그인 / 가입하기, then the lobby with the chip balance always on screen, the
// games, and the settlement request. Everything comes from the ledger server; the app keeps only its login token.
// When the server cannot be reached the app says so, keeps trying, and blocks anything that moves chips.
// A game opens on top of the lobby in a frame from the same server, under a bar that keeps the balance in view;
// it takes and gives back chips itself (sdk/casino.ts). Whatever way a game stops, its chips come back: the app
// settles leftovers whenever no game is open, and sends results still waiting in the outbox on every report.
// Through the tunnel (온라인판) the server says so at /api/hello: then login asks the 입장 코드, and the
// app asks for news every PLATFORM.online.pingMs instead of live updates (a Quick Tunnel does not pass them).
import './style.css';
import { PLATFORM, type GameDef } from '../shared/config.ts';
import type { AuthReply, Hello, MeReply, PlayerView } from '../shared/protocol.ts';
import { chips, clockTime, h, requestKey, setText } from '../ui/dom.ts';
import { ApiError, api } from '../ui/net.ts';
import { play, unlockAudio } from '../ui/sound.ts';
import { flush, settleLeftovers } from '../../sdk/casino.ts';

const TOKEN_KEY = 'casino:v1:token';
const SERVER_KEY = 'casino:v1:server';
const ENTRY_KEY = 'casino:v1:entry'; // the 입장 코드 last used, so a returning player need not type it again
const SEND_RETRY_MS = 30_000; // a chip request keeps trying this long through a Wi-Fi drop

const root = document.getElementById('app')!;
root.classList.add('app');

let base = serverBase();
let token = load(TOKEN_KEY);
let me: PlayerView | null = null;
let online = false;
let events: EventSource | null = null;
let pingTimer: number | null = null;
let busy = false; // a chip request is on its way
let cancelling = false;
let playing: GameDef | null = null; // the game open on top of the lobby
let hello: Hello = { online: false, pingMs: PLATFORM.pingMs, entryDigits: 0 }; // how this server address works

// ------------------------------------------------------------------ skeleton

const banner = h('div', { class: 'net-banner', hidden: true, 'data-testid': 'offline' }, '서버와 연결이 끊겼습니다 · 다시 연결하는 중…');
const toasts = h('div', { class: 'toasts' });
const screen = h('main', { class: 'screen' });
root.append(banner, screen, toasts);
window.addEventListener('pointerdown', unlockAudio, { capture: true });
window.addEventListener('keydown', unlockAudio, { capture: true });

// ------------------------------------------------------------------ login / signup

function showLogin(notice = ''): void {
  stopSession();
  let mode: 'login' | 'signup' = 'login';
  const name = h('input', { class: 'field', 'data-testid': 'name', maxlength: PLATFORM.nameMax, autocomplete: 'off', placeholder: '이름' });
  const pin = pinInput('pin', 'PIN 4자리');
  const pin2 = pinInput('pin2', 'PIN 한 번 더');
  const server = h('input', { class: 'field', 'data-testid': 'server', placeholder: '서버 주소 (예: 192.168.0.12:7777)', value: base });
  const entry = h('input', {
    class: 'field pin',
    inputmode: 'numeric',
    maxlength: hello.entryDigits,
    autocomplete: 'off',
    placeholder: `입장 코드 ${hello.entryDigits}자리`,
    value: load(ENTRY_KEY),
    'data-testid': 'entry',
  });
  entry.addEventListener('input', () => {
    const clean = entry.value.replace(/\D/g, '').slice(0, hello.entryDigits);
    if (clean !== entry.value) entry.value = clean;
  });
  const msg = h('div', { class: 'form-msg', 'data-testid': 'login-msg' }, notice);
  const submit = h('button', { class: 'btn primary wide', type: 'submit', 'data-testid': 'submit' }, '로그인');
  const tabLogin = h('button', { class: 'tab active', type: 'button', 'data-testid': 'tab-login' }, '로그인');
  const tabSignup = h('button', { class: 'tab', type: 'button', 'data-testid': 'tab-signup' }, '가입하기');
  const pin2Row = h('label', { class: 'row', hidden: true }, h('span', {}, 'PIN 확인'), pin2);
  const setMode = (m: typeof mode): void => {
    mode = m;
    tabLogin.classList.toggle('active', m === 'login');
    tabSignup.classList.toggle('active', m === 'signup');
    pin2Row.hidden = m === 'login';
    setText(submit, m === 'login' ? '로그인' : '가입하고 시작');
    setText(msg, m === 'signup' ? `처음 가입하면 ${PLATFORM.signupBonus}칩을 드려요` : '');
    msg.className = 'form-msg';
  };
  tabLogin.addEventListener('click', () => setMode('login'));
  tabSignup.addEventListener('click', () => setMode('signup'));

  const form = h(
    'form',
    { class: 'card login-card' },
    h('div', { class: 'logo' }, h('span', { class: 'logo-mark' }, '♠'), '카지노'),
    h('div', { class: 'tabs' }, tabLogin, tabSignup),
    h('label', { class: 'row' }, h('span', {}, '이름'), name),
    h('label', { class: 'row' }, h('span', {}, 'PIN'), pin),
    pin2Row,
    hello.entryDigits ? h('label', { class: 'row' }, h('span', {}, '입장 코드'), entry) : null,
    location.protocol.startsWith('http') ? null : h('label', { class: 'row' }, h('span', {}, '서버'), server),
    msg,
    submit,
  );
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    void (async () => {
      if (submit.disabled) return;
      if (!location.protocol.startsWith('http')) setServer(server.value);
      if (mode === 'signup' && pin.value !== pin2.value) return fail('PIN 두 번이 서로 다릅니다');
      submit.disabled = true;
      setText(submit, '연결 중…');
      try {
        const body = { name: name.value, pin: pin.value, key: requestKey(), ...(hello.entryDigits ? { code: entry.value } : {}) };
        const r = await api<AuthReply>(base, mode, body, { retryMs: 15_000 });
        if (hello.entryDigits) save(ENTRY_KEY, entry.value);
        token = r.token;
        save(TOKEN_KEY, token);
        play('coin');
        showLobby(r.me, mode === 'signup' ? `가입 완료! 보너스 ${PLATFORM.signupBonus}칩` : '');
      } catch (err) {
        if (err instanceof ApiError && err.code === 'entry') {
          // The code changed (a server restart or [새 코드]): never send the old one again by accident.
          if (!hello.entryDigits) {
            await greet(); // /api/hello was missed at boot: now the form needs the code field
            return showLogin(err.message);
          }
          entry.value = '';
          remove(ENTRY_KEY);
        }
        fail(err instanceof ApiError ? err.message : '오류가 났습니다');
        submit.disabled = false;
        setText(submit, mode === 'login' ? '로그인' : '가입하고 시작');
      }
    })();
  });
  function fail(text: string): void {
    setText(msg, text);
    msg.className = 'form-msg error';
    play('error');
  }
  screen.replaceChildren(h('div', { class: 'center' }, form));
  if (notice) msg.className = 'form-msg error';
  name.focus();
}

function pinInput(testid: string, placeholder: string): HTMLInputElement {
  const el = h('input', {
    class: 'field pin',
    type: 'password',
    inputmode: 'numeric',
    maxlength: PLATFORM.pinDigits,
    autocomplete: 'off',
    placeholder,
    'data-testid': testid,
  });
  el.addEventListener('input', () => {
    const clean = el.value.replace(/\D/g, '').slice(0, PLATFORM.pinDigits);
    if (clean !== el.value) el.value = clean;
  });
  return el;
}

// ------------------------------------------------------------------ lobby

const balanceEl = h('div', { class: 'balance-num', 'data-testid': 'balance' });
const breakdownEl = h('div', { class: 'balance-sub', 'data-testid': 'breakdown' });
const nameEl = h('div', { class: 'who-name', 'data-testid': 'who' });
const connEl = h('span', { class: 'conn' });
const noticeEl = h('div', { class: 'notice', hidden: true, 'data-testid': 'notice' });
const gamesEl = h('div', { class: 'games' });
const openGamesEl = h('div', { class: 'open-games', hidden: true, 'data-testid': 'open-games' });
const settleInput = h('input', { class: 'field amount', type: 'number', min: 1, step: 1, 'data-testid': 'settle-amount', placeholder: '칩 개수' });
const settleBtn = h('button', { class: 'btn gold', type: 'button', 'data-testid': 'settle' }, '정산 요청');
const settleMsg = h('div', { class: 'form-msg', 'data-testid': 'settle-msg' });
const pendingEl = h('div', { class: 'pending', hidden: true, 'data-testid': 'pending' });
const cancelBtn = h('button', { class: 'btn ghost small', type: 'button', 'data-testid': 'settle-cancel' }, '요청 취소');
const settleForm = h('div', { class: 'settle-form' }, settleInput, settleBtn);

settleBtn.addEventListener('click', () => void requestSettlement());
settleInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') void requestSettlement();
});
cancelBtn.addEventListener('click', () => void cancelSettlement());

function showLobby(first: PlayerView, hello = ''): void {
  me = first;
  online = true; // it just answered
  const logout = h('button', { class: 'btn ghost small', type: 'button', 'data-testid': 'logout' }, '로그아웃');
  logout.addEventListener('click', () => void doLogout());
  gamesEl.replaceChildren(...PLATFORM.games.map(gameTile));
  screen.replaceChildren(
    h(
      'div',
      { class: 'lobby' },
      h(
        'header',
        { class: 'top' },
        h('div', { class: 'logo small' }, h('span', { class: 'logo-mark' }, '♠'), '카지노'),
        connEl,
        h('div', { class: 'who' }, nameEl, logout),
      ),
      h(
        'section',
        { class: 'card balance-card' },
        h('div', { class: 'balance-label' }, '내 잔고'),
        balanceEl,
        breakdownEl,
        noticeEl,
      ),
      h('section', { class: 'card games-card' }, h('h2', {}, '게임'), gamesEl, openGamesEl),
      h(
        'section',
        { class: 'card settle-card' },
        h('h2', {}, '실물 칩으로 바꾸기'),
        h('p', { class: 'hint' }, '바꿀 칩 개수를 적고 요청하면, 관리자가 실물 칩을 건네고 장부에서 뺍니다.'),
        settleForm,
        pendingEl,
        settleMsg,
      ),
    ),
  );
  render();
  connect();
  void sweepGames();
  if (hello) toast(hello, 'good');
}

function gameTile(g: GameDef): HTMLElement {
  return h(
    'button',
    { class: `game-tile game-${g.id}`, type: 'button', 'data-testid': `game-${g.id}`, onclick: () => openGame(g) },
    h('div', { class: 'game-icon' }, g.id === 'yabawi' ? '🥤' : '📈'),
    h('div', { class: 'game-name' }, g.name),
    h('div', { class: 'game-desc' }, g.description),
    h('div', { class: 'game-rate' }, g.perChip === 1 ? '1칩 = 1칩' : `1칩 = ${g.unit}${g.perChip.toLocaleString('en-US')}`),
    h('div', { class: 'game-play' }, '▶ 시작'),
  );
}

// ------------------------------------------------------------------ games

const gameName = h('span', { class: 'gb-name' });
const gameBalance = h('span', { class: 'gb-balance', 'data-testid': 'game-balance' });
const gameConn = h('span', { class: 'conn' });
const gameLayer = h(
  'div',
  { class: 'game-layer', hidden: true, 'data-testid': 'game-layer' },
  h(
    'div',
    { class: 'game-bar' },
    h('div', { class: 'logo small' }, h('span', { class: 'logo-mark' }, '♠'), '카지노'),
    gameName,
    gameConn,
    gameBalance,
    h('button', { class: 'btn ghost small', type: 'button', 'data-testid': 'game-leave', onclick: () => leaveGame() }, '로비로'),
  ),
);
root.append(gameLayer);

function openGame(g: GameDef): void {
  if (!me || playing) return;
  if (!online) return toast('서버와 연결된 뒤에 시작하세요', 'bad');
  playing = g;
  setText(gameName, g.name);
  gameLayer.querySelector('iframe')?.remove();
  const speed = new URLSearchParams(location.search).get('speed'); // e2e only: faster 야바위 animations
  const src = `${base}games/${g.id}/?casino=1${speed ? `&speed=${encodeURIComponent(speed)}` : ''}`;
  gameLayer.append(h('iframe', { class: 'game-frame', src, title: g.name, 'data-testid': 'game-frame' }));
  gameLayer.hidden = false;
  play('click');
  render();
}

/** The lobby's own way out (the games have theirs): a game left in the middle is settled at its current value. */
function leaveGame(): void {
  if (!playing) return;
  if (!window.confirm(`${playing.name}을(를) 닫을까요? 진행 중인 게임은 지금 상태로 정산됩니다.`)) return;
  closeGame();
}

function closeGame(): void {
  gameLayer.querySelector('iframe')?.remove();
  gameLayer.hidden = true;
  playing = null;
  void sweepGames();
}

/** Settles games that stopped without reporting, and sends results waiting in the outbox. */
async function sweepGames(): Promise<void> {
  if (!playing) await settleLeftovers();
  await flush();
  if (token && me) {
    try {
      update((await api<MeReply>(base, 'me', undefined, { token })).me);
    } catch {
      // the next report brings it
    }
  }
}

window.addEventListener('message', (e) => {
  if (e.origin !== location.origin || (e.data as { type?: string } | null)?.type !== 'casino:exit') return;
  closeGame();
});

function render(): void {
  if (!me) return;
  setText(nameEl, me.name);
  setText(balanceEl, chips(me.total));
  const parts = [`사용 가능 ${me.free}`];
  if (me.held) parts.push(`정산 대기 ${me.held}`);
  if (me.inGame) parts.push(`게임 중 ${me.inGame}`);
  setText(breakdownEl, parts.join(' · '));
  setText(connEl, online ? '● 서버 연결됨' : '○ 연결 끊김');
  connEl.classList.toggle('off', !online);
  setText(gameConn, online ? '● 연결됨' : '○ 연결 끊김');
  gameConn.classList.toggle('off', !online);
  setText(gameBalance, `내 잔고 ${chips(me.total)}${me.inGame ? ` · 게임 중 ${me.inGame}` : ''}`);
  for (const b of gamesEl.querySelectorAll('button')) b.disabled = !online;
  banner.hidden = online;

  noticeEl.hidden = !me.bankrupt;
  if (me.bankrupt) setText(noticeEl, '잔고가 0칩이 되어 파산 신청이 접수되었습니다. 관리자에게 가 주세요.');

  openGamesEl.hidden = me.games.length === 0;
  openGamesEl.replaceChildren(
    h('div', { class: 'open-title' }, '진행 중인 게임 (끝나면 칩이 돌아옵니다)'),
    ...me.games.map((g) =>
      h(
        'div',
        { class: `open-row${g.review === null ? '' : ' review'}`, 'data-testid': g.review === null ? null : 'review' },
        `${PLATFORM.games.find((d) => d.id === g.game)?.name ?? g.game} · ${chips(g.stake)} · ${clockTime(g.openedAt)} 시작`,
        g.review === null ? '' : ` · ${chips(g.review)} 지급을 관리자가 확인하는 중`,
      ),
    ),
  );

  const r = me.settlement;
  settleForm.hidden = !!r;
  pendingEl.hidden = !r;
  if (r) {
    pendingEl.replaceChildren(
      h('div', { class: 'pending-title' }, `실물 ${chips(r.amount)} 정산 요청 중`),
      h('div', { class: 'pending-sub' }, `${clockTime(r.requestedAt)} 요청 · 관리자 확인을 기다리는 중`),
      cancelBtn,
    );
  }
  settleInput.max = String(me.free);
  settleBtn.disabled = !online || busy || me.free < 1;
  cancelBtn.disabled = !online || busy;
}

/** A new view from the server: tells the player what changed, then redraws. */
function update(next: PlayerView): void {
  const prev = me;
  me = next;
  if (prev) {
    if (prev.settlement && !next.settlement) {
      if (next.total < prev.total) {
        toast(`실물 ${chips(prev.settlement.amount)} 정산 완료! 관리자에게 받으세요`, 'good');
        play('cashout');
      } else if (!cancelling) {
        toast('정산 요청이 거절되었습니다', 'bad');
        play('error');
      }
    } else if (next.total > prev.total) {
      toast(`잔고 ${chips(prev.total)} → ${chips(next.total)}`, 'good');
      play('coin');
      flash('up');
    } else if (next.total < prev.total) {
      toast(`잔고 ${chips(prev.total)} → ${chips(next.total)}`, 'bad');
      flash('down');
    }
    if (!prev.bankrupt && next.bankrupt) play('error');
  }
  render();
}

function flash(dir: 'up' | 'down'): void {
  balanceEl.classList.remove('flash-up', 'flash-down');
  void balanceEl.offsetWidth; // restart the animation
  balanceEl.classList.add(dir === 'up' ? 'flash-up' : 'flash-down');
}

async function requestSettlement(): Promise<void> {
  if (!me || busy) return;
  const amount = Number(settleInput.value);
  if (!Number.isInteger(amount) || amount < 1) return settleError('1칩 이상, 정수로 적어 주세요');
  if (amount > me.free) return settleError(`사용 가능한 칩은 ${chips(me.free)}입니다`);
  busy = true;
  render();
  setText(settleBtn, '보내는 중…');
  setText(settleMsg, '');
  try {
    const r = await api<MeReply>(base, 'settle', { amount, key: requestKey() }, {
      token,
      retryMs: SEND_RETRY_MS,
      onRetry: () => setText(settleMsg, '연결이 불안정합니다 · 다시 보내는 중…'),
    });
    settleInput.value = '';
    setText(settleMsg, '');
    play('click');
    update(r.me);
  } catch (err) {
    handleError(err, settleError);
  } finally {
    busy = false;
    setText(settleBtn, '정산 요청');
    render();
  }
}

async function cancelSettlement(): Promise<void> {
  if (!me?.settlement || busy) return;
  busy = cancelling = true;
  render();
  try {
    const r = await api<MeReply>(base, 'settle/cancel', { id: me.settlement.id }, { token, retryMs: SEND_RETRY_MS });
    update(r.me);
    toast('정산 요청을 취소했습니다', 'info');
  } catch (err) {
    handleError(err, settleError);
  } finally {
    busy = cancelling = false;
    render();
  }
}

function settleError(text: string): void {
  setText(settleMsg, text);
  settleMsg.className = 'form-msg error';
  play('error');
  window.setTimeout(() => (settleMsg.className = 'form-msg'), 4000);
}

function handleError(err: unknown, show: (t: string) => void): void {
  if (err instanceof ApiError && err.code === 'session') return endSession('다시 로그인하세요');
  show(err instanceof ApiError ? err.message : '오류가 났습니다');
}

// ------------------------------------------------------------------ connection

/**
 * Live updates by server-sent events, plus a report every PLATFORM.pingMs that keeps the player online. Through the
 * tunnel the reports alone carry the news, more often (hello.pingMs); a replaced login shows up as 'session' there.
 */
function connect(): void {
  stopSession(false);
  pingTimer = window.setInterval(() => void ping(), hello.pingMs);
  if (hello.online) return;
  events = new EventSource(`${base}api/events?token=${encodeURIComponent(token)}`);
  events.addEventListener('me', (ev) => {
    setOnline(true);
    update(JSON.parse((ev as MessageEvent).data) as PlayerView);
  });
  events.addEventListener('kicked', (ev) => endSession((JSON.parse((ev as MessageEvent).data) as { reason: string }).reason));
  events.onopen = () => setOnline(true);
  events.onerror = () => setOnline(false); // EventSource reconnects by itself
}

async function ping(): Promise<void> {
  try {
    const r = await api<MeReply>(base, 'ping', {}, { token });
    setOnline(true);
    update(r.me);
    void flush(); // results that waited for the server
  } catch (err) {
    if (err instanceof ApiError && err.code === 'session') endSession('다시 로그인하세요');
    else setOnline(false);
  }
}

function setOnline(v: boolean): void {
  if (online === v) return;
  online = v;
  render();
}

function stopSession(clearToken = true): void {
  events?.close();
  events = null;
  if (pingTimer !== null) window.clearInterval(pingTimer);
  pingTimer = null;
  if (clearToken) {
    me = null;
    banner.hidden = true;
  }
}

/** The server ended this login (another PC logged in, the account was deleted, ...). A game left open is settled. */
function endSession(reason: string): void {
  token = '';
  remove(TOKEN_KEY);
  if (playing) closeGame();
  showLogin(reason);
}

async function doLogout(): Promise<void> {
  if (playing) closeGame();
  const t = token;
  token = '';
  remove(TOKEN_KEY);
  showLogin();
  try {
    await api(base, 'logout', {}, { token: t });
  } catch {
    // the login ends anyway the next time someone logs in
  }
}

// ------------------------------------------------------------------ effects

function toast(text: string, kind: 'good' | 'bad' | 'info'): void {
  const el = h('div', { class: `toast ${kind}` }, text);
  toasts.append(el);
  while (toasts.children.length > 4) toasts.firstElementChild?.remove();
  window.setTimeout(() => el.classList.add('out'), 3200);
  window.setTimeout(() => el.remove(), 3700);
}

// ------------------------------------------------------------------ storage and server address

function serverBase(): string {
  if (location.protocol.startsWith('http')) return `${location.origin}/`;
  const q = new URLSearchParams(location.search).get('server');
  return normalizeServer(q ?? load(SERVER_KEY));
}

function setServer(raw: string): void {
  base = normalizeServer(raw);
  save(SERVER_KEY, base);
}

function normalizeServer(raw: string): string {
  const v = raw.trim();
  if (!v) return '';
  const withScheme = /^https?:\/\//.test(v) ? v : `http://${v}`;
  return withScheme.endsWith('/') ? withScheme : `${withScheme}/`;
}

function load(key: string): string {
  try {
    return localStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
}
function save(key: string, v: string): void {
  try {
    localStorage.setItem(key, v);
  } catch {
    // the login lasts until the window closes
  }
}
function remove(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // nothing stored
  }
}

// ------------------------------------------------------------------ boot

/** Through the tunnel or on the Wi-Fi? An old server without /api/hello is the Wi-Fi kind. */
async function greet(): Promise<void> {
  try {
    hello = await api<Hello>(base, 'hello', undefined, { retryMs: 10_000 });
  } catch {
    // keeps the Wi-Fi default
  }
}

/** With a saved login, waits for the server (it may be restarting) instead of asking to log in again. */
async function boot(): Promise<void> {
  if (base) await greet();
  if (!token) return showLogin();
  screen.replaceChildren(h('div', { class: 'center' }, h('div', { class: 'card connecting', 'data-testid': 'connecting' }, '서버에 연결하는 중…')));
  for (;;) {
    try {
      const r = await api<MeReply>(base, 'me', undefined, { token });
      online = true;
      return showLobby(r.me);
    } catch (err) {
      if (err instanceof ApiError && err.code !== 'network' && err.status < 500) return endSession('다시 로그인하세요');
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

void boot();
