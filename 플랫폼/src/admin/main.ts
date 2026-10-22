// Admin screen on the admin PC: every player live with 수정 · 정산 · 삭제, the 메시지 panel (players' messages,
// 정산 요청, big online wins to approve, games that stopped reporting), and the DB 기록 window with every edit,
// delete and settlement. Everything comes from the server's event stream; every action is a request the server checks
// again, so a double click or a stale screen cannot do a thing twice or undo a change it did not see.
import './style.css';
import { PLATFORM } from '../shared/config.ts';
import {
  GAME_KINDS,
  LOG_LABEL,
  type AdminEvents,
  type AdminGame,
  type AdminMessage,
  type AdminPlayer,
  type AdminSettlement,
  type AdminState,
  type LogRecord,
} from '../shared/protocol.ts';
import { ago, chips, clockTime, duration, h, requestKey, setText, signed } from '../ui/dom.ts';
import { ApiError, api } from '../ui/net.ts';
import { play, unlockAudio } from '../ui/sound.ts';

const BASE = `${location.origin}/`;
const LOG_ROWS = 500; // the DB 기록 table shows this many; the CSV has everything

let state: AdminState | null = null;
let log: LogRecord[] = [];
let receivedAt = 0;
let connected = false;
let tab: 'players' | 'log' = 'players';
let search = '';
let logAll = false;
let logSearch = '';
const seenRequests = new Set<string>();
const handled = new Set<string>(); // cards acted on here: hidden at once, before the server's update arrives
let firstSnapshot = true;

const root = document.getElementById('app')!;
root.classList.add('admin');
window.addEventListener('pointerdown', unlockAudio, { capture: true });

// ------------------------------------------------------------------ skeleton

const statusEl = h('span', { class: 'status', 'data-testid': 'status' });
const summaryEl = h('div', { class: 'summary', 'data-testid': 'summary' });
const onlineEl = h('div', { class: 'online-box', hidden: true, 'data-testid': 'online' }); // internet address, 입장 코드
const tabPlayers = h('button', { class: 'tab', type: 'button', 'data-testid': 'tab-players' });
const tabLog = h('button', { class: 'tab', type: 'button', 'data-testid': 'tab-log' });
const searchInput = h('input', { class: 'search', type: 'search', placeholder: '이름 검색', 'data-testid': 'search' });
const tbody = h('tbody', { 'data-testid': 'players' });
const emptyEl = h('div', { class: 'empty' }, '아직 가입한 플레이어가 없습니다');
const reqMessages = h('div', { class: 'req-list', 'data-testid': 'messages' });
const reqReview = h('div', { class: 'req-list', 'data-testid': 'reviews' });
const reqSettle = h('div', { class: 'req-list', 'data-testid': 'requests' });
const reqGames = h('div', { class: 'req-list', 'data-testid': 'open-games' });
const readMessages = h('div', { class: 'req-list read', 'data-testid': 'read-messages' });
const READ_SHOWN = 10; // read messages kept below the rest
const noReqEl = h('div', { class: 'empty small' }, '새 메시지가 없습니다');
const logBody = h('tbody', { 'data-testid': 'log' });
const logNote = h('div', { class: 'log-note' });
const logAllBtn = h('button', { class: 'chip-btn', type: 'button', 'data-testid': 'log-all' });
const logSearchInput = h('input', { class: 'search', type: 'search', placeholder: '플레이어 검색' });
const banner = h('div', { class: 'net-banner', hidden: true }, '장부 서버와 연결이 끊겼습니다 · 다시 연결하는 중…');
const toasts = h('div', { class: 'toasts' });
const overlay = h('div', { class: 'overlay', hidden: true });

const playersView = h(
  'div',
  { class: 'players-view' },
  h(
    'section',
    { class: 'panel table-panel' },
    h('div', { class: 'panel-head' }, h('h2', {}, '플레이어 DB'), searchInput),
    h(
      'div',
      { class: 'table-wrap' },
      h(
        'table',
        { class: 'grid players-table' },
        h(
          'thead',
          {},
          h(
            'tr',
            {},
            ...['상태', '이름', 'PIN', '잔고', '가입 시각', '최근 활동', '접속 시간', '게임', '관리'].map((t) => h('th', {}, t)),
          ),
        ),
        tbody,
      ),
      emptyEl,
    ),
  ),
  h(
    'aside',
    { class: 'panel side-panel' },
    h('h2', {}, '메시지'),
    noReqEl,
    h('div', { class: 'req-group' }, reqMessages),
    h('div', { class: 'req-group' }, reqReview),
    h('div', { class: 'req-group' }, reqSettle),
    h('div', { class: 'req-group' }, reqGames),
    h('div', { class: 'req-group' }, readMessages),
  ),
);

const csvLink = h('a', { class: 'btn small', href: `${BASE}api/admin/log.csv`, download: '', 'data-testid': 'csv' }, 'CSV 내보내기');
const logView = h(
  'section',
  { class: 'panel log-view', hidden: true },
  h('div', { class: 'panel-head' }, h('h2', {}, 'DB 기록'), logAllBtn, logSearchInput, csvLink),
  h(
    'div',
    { class: 'table-wrap' },
    h(
      'table',
      { class: 'grid log-table' },
      h('thead', {}, h('tr', {}, ...['번호', '시각', '종류', '플레이어', '잔고 변화', '잔고', '내용'].map((t) => h('th', {}, t)))),
      logBody,
    ),
  ),
  logNote,
);

root.append(
  banner,
  h(
    'header',
    { class: 'top' },
    h(
      'div',
      { class: 'brand' },
      h('span', { class: 'mark' }, '♠'),
      '카지노 장부',
      h('small', {}, '관리자'),
      // Opens in the PC's browser (a second screen or a projector): every player by 잔고, live.
      h('a', { class: 'btn small', href: `${BASE}rank`, target: '_blank', 'data-testid': 'rank-link' }, '순위 대시보드'),
      h('a', { class: 'btn small', href: `${BASE}sim`, target: '_blank', 'data-testid': 'sim-link' }, '확률 시뮬레이터'),
    ),
    statusEl,
    summaryEl,
    onlineEl,
  ),
  h('nav', { class: 'tabs' }, tabPlayers, tabLog),
  playersView,
  logView,
  overlay,
  toasts,
);

tabPlayers.addEventListener('click', () => setTab('players'));
tabLog.addEventListener('click', () => setTab('log'));
searchInput.addEventListener('input', () => {
  search = searchInput.value.trim().toLowerCase();
  renderPlayers();
});
logAllBtn.addEventListener('click', () => {
  logAll = !logAll;
  renderLog();
});
logSearchInput.addEventListener('input', () => {
  logSearch = logSearchInput.value.trim().toLowerCase();
  renderLog();
});

function setTab(t: typeof tab): void {
  tab = t;
  playersView.hidden = t !== 'players';
  logView.hidden = t !== 'log';
  render();
}

// ------------------------------------------------------------------ connection

function connect(): void {
  const es = new EventSource(`${BASE}api/admin/events`);
  es.addEventListener('snapshot', (ev) => {
    const data = JSON.parse((ev as MessageEvent).data) as AdminEvents['snapshot'];
    log = data.log;
    receive(data);
  });
  es.addEventListener('update', (ev) => {
    const data = JSON.parse((ev as MessageEvent).data) as AdminEvents['update'];
    log.push(...data.log);
    receive(data);
  });
  es.onopen = () => setConnected(true);
  es.onerror = () => setConnected(false);
}

function receive(s: AdminState): void {
  state = s;
  receivedAt = Date.now();
  const live = new Set([...s.settlements, ...s.messages.filter((m) => !m.read), ...s.games].map((r) => r.id));
  for (const id of handled) if (!live.has(id)) handled.delete(id);
  setConnected(true);
  // A new message or request is something the admin has to look at: sound and highlight (not for the ones already there).
  const reviews = s.games.filter((g) => g.review !== null).map((g) => ({ id: `review:${g.id}` }));
  const fresh = [...s.settlements, ...s.messages.filter((m) => !m.read), ...reviews].filter((r) => !seenRequests.has(r.id));
  for (const r of fresh) seenRequests.add(r.id);
  if (fresh.length && !firstSnapshot) play('alert');
  firstSnapshot = false;
  render();
}

function setConnected(v: boolean): void {
  connected = v;
  banner.hidden = v;
  setText(statusEl, v ? '● 서버 연결됨' : '○ 연결 끊김');
  statusEl.classList.toggle('off', !v);
}

// ------------------------------------------------------------------ render

function render(): void {
  if (!state) return;
  const s = state;
  const online = s.players.filter((p) => p.online).length;
  const waiting = s.settlements.length + s.messages.filter((m) => !m.read).length + s.games.filter((g) => g.review !== null).length;
  summaryEl.replaceChildren(
    stat('플레이어', `${s.players.length}명`),
    stat('접속 중', `${online}명`),
    stat('잔고 합계', chips(s.totals.outstanding)),
    stat('지급한 실물 칩', chips(s.totals.settled)),
    stat('새 메시지', `${waiting}건`, waiting > 0),
  );
  renderOnline(s);
  setText(tabPlayers, `플레이어 (${s.players.length})`);
  setText(tabLog, `DB 기록 (${log.filter((r) => !GAME_KINDS.has(r.kind)).length})`);
  tabPlayers.classList.toggle('active', tab === 'players');
  tabLog.classList.toggle('active', tab === 'log');
  if (tab === 'players') {
    renderPlayers();
    renderRequests();
  } else renderLog();
}

/** 온라인판: the tunnel's internet address (it changes whenever cloudflared starts again) and the 입장 코드. */
let onlineKey = '';
function renderOnline(s: AdminState): void {
  const o = s.server.online;
  onlineEl.hidden = !o;
  if (!o) return;
  const key = JSON.stringify(o);
  if (key === onlineKey) return; // kept as is, so the copy button is not redrawn under the mouse
  onlineKey = key;
  const copy = h('button', { class: 'btn small', type: 'button', disabled: !o.url, 'data-testid': 'online-copy' }, '복사');
  copy.addEventListener('click', () => {
    if (!o.url) return;
    void navigator.clipboard?.writeText(o.url).then(
      () => toast('인터넷 주소를 복사했습니다', 'good'),
      () => toast('복사하지 못했습니다. 주소를 직접 고르세요', 'bad'),
    );
  });
  const newCode = h('button', { class: 'btn small', type: 'button', 'data-testid': 'online-new-code' }, '새 코드');
  newCode.addEventListener('click', () =>
    confirmDialog('입장 코드를 바꿀까요?', '이미 로그인한 플레이어는 그대로이고, 새로 가입하거나 로그인할 때 새 코드가 필요합니다.', '바꾸기', 'gold', () =>
      post('online/code', {}, '입장 코드를 바꿨습니다'),
    ),
  );
  onlineEl.replaceChildren(
    h('span', { class: 'urls-label' }, '인터넷 주소'),
    h('code', { class: `online-url ${o.status}`, 'data-testid': 'online-url', title: o.message }, o.url ?? o.message),
    copy,
    h('span', { class: `online-status ${o.status}` }, o.status === 'up' ? '● 열림' : o.status === 'stopped' ? '○ 꺼짐' : '◌ 연결 중'),
    h('span', { class: 'urls-label' }, '입장 코드'),
    h('code', { class: 'online-code', 'data-testid': 'online-code' }, o.code),
    newCode,
  );
  if (o.status === 'up' && o.url && lastOnlineUrl && lastOnlineUrl !== o.url) toast('인터넷 주소가 바뀌었습니다. 플레이어에게 새 주소를 알려 주세요', 'bad');
  if (o.url) lastOnlineUrl = o.url;
}
let lastOnlineUrl = '';

function stat(label: string, value: string, hot = false): HTMLElement {
  return h('div', { class: `stat${hot ? ' hot' : ''}` }, h('span', {}, label), h('b', {}, value));
}

interface Row {
  tr: HTMLTableRowElement;
  dot: HTMLElement;
  name: HTMLElement;
  pin: HTMLElement;
  total: HTMLElement;
  sub: HTMLElement;
  created: HTMLElement;
  last: HTMLElement;
  active: HTMLElement;
  games: HTMLElement;
}
const rows = new Map<string, Row>();

/** Rows are kept and updated in place, so a click is never lost to a redraw. */
function renderPlayers(): void {
  if (!state) return;
  const now = Date.now();
  const list = state.players
    .filter((p) => !search || p.name.toLowerCase().includes(search))
    .sort((a, b) => Number(b.online) - Number(a.online) || b.lastActiveAt - a.lastActiveAt);
  const ids = new Set(list.map((p) => p.id));
  for (const [id, r] of rows) {
    if (!ids.has(id)) {
      r.tr.remove();
      rows.delete(id);
    }
  }
  list.forEach((p, i) => {
    let r = rows.get(p.id);
    if (!r) rows.set(p.id, (r = makeRow(p.id)));
    fillRow(r, p, now);
    if (tbody.children[i] !== r.tr) tbody.insertBefore(r.tr, tbody.children[i] ?? null);
  });
  emptyEl.hidden = state.players.length > 0;
}

function makeRow(id: string): Row {
  const cell = (cls = ''): HTMLTableCellElement => h('td', { class: cls });
  const r: Row = {
    tr: h('tr', { 'data-id': id }),
    dot: h('span', { class: 'dot' }),
    name: h('span', { class: 'p-name' }),
    pin: cell('mono'),
    total: h('b', { class: 'total' }),
    sub: h('div', { class: 'sub' }),
    created: cell('time'),
    last: cell('time'),
    active: cell('time'),
    games: cell('num'),
  };
  const find = (): AdminPlayer | undefined => state?.players.find((x) => x.id === id);
  const act = (label: string, cls: string, fn: (p: AdminPlayer) => void, testid: string) =>
    h('button', { class: `btn small ${cls}`, type: 'button', 'data-testid': testid, onclick: () => { const p = find(); if (p) fn(p); } }, label);
  r.tr.append(
    h('td', {}, r.dot),
    h('td', {}, r.name),
    r.pin,
    h('td', { class: 'num' }, r.total, r.sub),
    r.created,
    r.last,
    r.active,
    r.games,
    h('td', { class: 'actions' }, act('수정', '', editDialog, 'edit'), act('정산', 'gold', settleDialog, 'settle'), act('삭제', 'danger', deleteDialog, 'delete')),
  );
  return r;
}

function fillRow(r: Row, p: AdminPlayer, now: number): void {
  r.dot.className = `dot ${p.online ? 'on' : 'off'}`;
  r.dot.title = p.online ? '온라인' : '오프라인';
  setText(r.dot, p.online ? '온라인' : '오프라인');
  setText(r.name, p.name + (p.deathClears ? ` · 데스 게임 ${p.deathClears}회` : ''));
  setText(r.pin, p.pin);
  setText(r.total, chips(p.total));
  const parts = [];
  if (p.held) parts.push(`정산 대기 ${p.held}`);
  if (p.inGame) parts.push(`게임 중 ${p.inGame}`);
  setText(r.sub, parts.join(' · '));
  setText(r.created, clockTime(p.createdAt, now));
  setText(r.last, p.online ? '지금' : ago(p.lastActiveAt, now));
  setText(r.active, duration(p.activeMs + (p.online ? now - receivedAt : 0)));
  setText(r.games, p.played ? `${p.played}판 · ${signed(p.net)}` : '—');
}

// Request cards, keyed like the rows.
const cards = new Map<string, HTMLElement>();

function renderRequests(): void {
  if (!state) return;
  const now = Date.now();
  const keep = new Set<string>();
  const place = (list: HTMLElement, items: HTMLElement[]): void => {
    items.forEach((el, i) => {
      if (list.children[i] !== el) list.insertBefore(el, list.children[i] ?? null);
    });
  };
  const open = <T extends { id: string }>(list: T[]): T[] => list.filter((r) => !handled.has(r.id));
  place(
    reqMessages,
    open(state.messages.filter((m) => !m.read)).map((m) => card(`m:${m.id}`, keep, () => messageCard(m), (el) => setText(el.querySelector('.ago')!, ago(m.at, now)))),
  );
  place(
    reqReview,
    open(state.games.filter((g) => g.review !== null)).map((g) =>
      card(`r:${g.id}`, keep, () => reviewCard(g), (el) => setText(el.querySelector('.ago')!, `${duration(now - g.openedAt)}째`)),
    ),
  );
  place(
    reqSettle,
    open(state.settlements)
      .sort((a, b) => a.requestedAt - b.requestedAt)
      .map((r) => card(`s:${r.id}`, keep, () => settlementCard(r), (el) => setText(el.querySelector('.ago')!, ago(r.requestedAt, now)))),
  );

  place(
    reqGames,
    open(state.games.filter((g) => g.review === null)).map((g) =>
      card(`g:${g.id}`, keep, () => gameCard(g), (el) => {
        const owner = state?.players.find((p) => p.id === g.playerId);
        setText(el.querySelector('.ago')!, `${duration(now - g.openedAt)}째 · ${owner?.online ? '접속 중' : '연결 끊김'}`);
      }),
    ),
  );
  const unread = keep.size; // everything above still waits for the admin
  place(
    readMessages,
    state.messages
      .filter((m) => m.read || handled.has(m.id))
      .slice(0, READ_SHOWN)
      .map((m) => card(`d:${m.id}`, keep, () => messageCard(m, true), (el) => setText(el.querySelector('.ago')!, ago(m.at, now)))),
  );
  for (const [k, el] of cards) {
    if (!keep.has(k)) {
      el.remove();
      cards.delete(k);
    }
  }
  noReqEl.hidden = unread > 0;
}

function card(key: string, keep: Set<string>, make: () => HTMLElement, refresh: (el: HTMLElement) => void): HTMLElement {
  keep.add(key);
  let el = cards.get(key);
  if (!el) {
    cards.set(key, (el = make()));
    el.classList.add('fresh');
  }
  refresh(el);
  return el;
}

/**
 * A 정산 요청. The ledger comes first: [지급 확정] takes the chips off the ledger, and only then does the admin hand
 * over the physical chips. The other way round, a player could cancel the request on their PC between getting the
 * chips and the click, and keep both.
 */
function settlementCard(r: AdminSettlement): HTMLElement {
  const p = state?.players.find((x) => x.id === r.playerId);
  const history = p
    ? `PIN ${p.pin} · ${ago(p.createdAt)} 가입 · 게임 ${p.played}판${p.played ? ` (${signed(p.net)})` : ''}`
    : '';
  return h(
    'div',
    { class: 'req settle', 'data-testid': 'request' },
    h('div', { class: 'req-title' }, h('b', {}, r.name), ` 실물 ${chips(r.amount)} 정산 요청`),
    h('div', { class: 'req-sub' }, h('span', { class: 'ago' }), ` · ${clockTime(r.requestedAt)}`),
    h('div', { class: 'req-sub' }, history),
    h(
      'div',
      { class: 'req-actions' },
      h('button', { class: 'btn small gold', type: 'button', 'data-testid': 'request-done', onclick: () => confirmDialog(`${r.name} 실물 ${chips(r.amount)} 지급`, `[지급 확정]을 누르면 장부에서 ${chips(r.amount)}이 빠집니다. 확정된 뒤에 실물 칩을 건네세요. (본인 확인: PIN ${p?.pin ?? '?'})`, '지급 확정', 'gold', () => post('settle/done', { id: r.id }, `확정! ${r.name}에게 실물 ${chips(r.amount)}을 건네세요`, r.id)) }, '지급 확정'),
      h('button', { class: 'btn small', type: 'button', 'data-testid': 'request-reject', onclick: () => confirmDialog(`${r.name}의 정산 요청을 거절할까요?`, `${chips(r.amount)}이 플레이어에게 다시 사용 가능해집니다.`, '거절', 'danger', () => post('settle/reject', { id: r.id }, '정산 요청을 거절했습니다', r.id)) }, '거절'),
    ),
  );
}

/** A player's message. [확인] marks it read: it moves down to the read ones (and the player sees it was read). */
function messageCard(m: AdminMessage, read = false): HTMLElement {
  const p = state?.players.find((x) => x.id === m.playerId);
  return h(
    'div',
    { class: `req message${read ? ' read' : ''}`, 'data-testid': read ? 'read-message' : 'message' },
    h('div', { class: 'req-title' }, h('b', {}, m.name), p ? ` · 잔고 ${chips(p.total)}` : ''),
    h('div', { class: 'req-text' }, m.text),
    h('div', { class: 'req-sub' }, h('span', { class: 'ago' }), ` · ${clockTime(m.at)}`),
    read
      ? null
      : h(
          'div',
          { class: 'req-actions' },
          h('button', { class: 'btn small', type: 'button', 'data-testid': 'message-read', onclick: () => void post('message/read', { id: m.id }, '확인했습니다', m.id) }, '확인'),
        ),
  );
}

/** 온라인판: a big win through the tunnel. Approve pays what the game reported; reject gives the stake back. */
function reviewCard(g: AdminGame): HTMLElement {
  const name = PLATFORM.games.find((d) => d.id === g.game)?.name ?? g.game;
  const p = state?.players.find((x) => x.id === g.playerId);
  const payout = g.review ?? 0;
  const history = p ? `${ago(p.createdAt)} 가입 · 게임 ${p.played}판${p.played ? ` (${signed(p.net)})` : ''}` : '';
  return h(
    'div',
    { class: 'req review', 'data-testid': 'review' },
    h('div', { class: 'req-title' }, h('b', {}, g.name), ` ${name} ${chips(g.stake)} → ${chips(payout)} 지급 확인 (온라인)`),
    h('div', { class: 'req-sub' }, h('span', { class: 'ago' }), ` · 순이익 ${signed(payout - g.stake)}칩`),
    h('div', { class: 'req-sub' }, history),
    h(
      'div',
      { class: 'req-actions' },
      h('button', { class: 'btn small gold', type: 'button', 'data-testid': 'review-approve', onclick: () => confirmDialog(`${g.name}에게 ${chips(payout)} 지급`, `${name} 결과를 그대로 인정합니다. 잔고에 ${chips(payout)}이 들어갑니다.`, '승인', 'gold', () => post('review', { id: g.id, approve: true }, `승인했습니다 · ${chips(payout)} 지급`, g.id)) }, '승인'),
      h('button', { class: 'btn small', type: 'button', 'data-testid': 'review-reject', onclick: () => confirmDialog(`${g.name}의 결과를 거절할까요?`, `판돈 ${chips(g.stake)}만 돌려줍니다. 조작이 의심될 때 쓰세요.`, '거절', 'danger', () => post('review', { id: g.id, approve: false }, `거절했습니다 · 판돈 ${chips(g.stake)} 반환`, g.id)) }, '거절'),
    ),
  );
}

function gameCard(g: AdminGame): HTMLElement {
  const name = PLATFORM.games.find((d) => d.id === g.game)?.name ?? g.game;
  return h(
    'div',
    { class: 'req game', 'data-testid': 'open-game' },
    h('div', { class: 'req-title' }, h('b', {}, g.name), ` ${name} 게임 중 · ${chips(g.stake)} 걸림`),
    h('div', { class: 'req-sub' }, h('span', { class: 'ago' })),
    h('div', { class: 'req-actions' }, h('button', { class: 'btn small', type: 'button', onclick: () => forceCloseDialog(g, name) }, '강제 종료')),
  );
}

function renderLog(): void {
  setText(logAllBtn, logAll ? '전체 (게임 입출금 포함)' : '관리 기록만');
  logAllBtn.classList.toggle('on', logAll);
  const matched = log.filter((r) => (logAll || !GAME_KINDS.has(r.kind)) && (!logSearch || r.name.toLowerCase().includes(logSearch)));
  const shown = matched.slice(-LOG_ROWS).reverse();
  logBody.replaceChildren(
    ...shown.map((r) =>
      h(
        'tr',
        { class: `k-${r.kind}` },
        h('td', { class: 'num' }, r.seq),
        h('td', { class: 'time' }, fullTime(r.at)),
        h('td', {}, h('span', { class: `kind k-${r.kind}` }, LOG_LABEL[r.kind])),
        h('td', {}, r.name),
        h('td', { class: `num ${r.delta > 0 ? 'up' : r.delta < 0 ? 'down' : ''}` }, r.delta ? signed(r.delta) : '·'),
        h('td', { class: 'num' }, r.chips),
        h('td', {}, r.text),
      ),
    ),
  );
  setText(logNote, matched.length > LOG_ROWS ? `최근 ${LOG_ROWS}건만 보입니다 · 전체 ${matched.length}건은 CSV로` : `${matched.length}건`);
}

function fullTime(ms: number): string {
  const d = new Date(ms);
  const z = (n: number): string => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${z(d.getHours())}:${z(d.getMinutes())}:${z(d.getSeconds())}`;
}

// ------------------------------------------------------------------ actions

/** Sends an admin action; null when done, else the error to show. A card acted on (`cardId`) goes away at once. */
async function post(path: string, body: unknown, done: string, cardId?: string): Promise<string | null> {
  try {
    await api(BASE, `admin/${path}`, body, { retryMs: 10_000 });
    toast(done, 'good');
    play('coin');
    if (cardId) {
      handled.add(cardId);
      renderRequests();
    }
    return null;
  } catch (err) {
    play('error');
    if (cardId && err instanceof ApiError && err.code === 'gone') {
      handled.add(cardId); // someone else (or the player) got there first
      renderRequests();
    }
    return err instanceof ApiError ? err.message : '오류가 났습니다';
  }
}

interface DialogParts {
  title: string;
  body: HTMLElement[];
  ok: string;
  kind: 'gold' | 'danger';
  /** Runs the action; returns an error to show, or null when done. */
  run: () => Promise<string | null>;
}

function dialog(d: DialogParts): void {
  const msg = h('div', { class: 'dlg-msg', 'data-testid': 'dialog-msg' });
  const ok = h('button', { class: `btn ${d.kind}`, type: 'submit', 'data-testid': 'dialog-ok' }, d.ok);
  const cancel = h('button', { class: 'btn', type: 'button', 'data-testid': 'dialog-cancel' }, '취소');
  const form = h('form', { class: 'dialog', 'data-testid': 'dialog' }, h('h3', {}, d.title), ...d.body, msg, h('div', { class: 'dlg-actions' }, cancel, ok));
  const close = (): void => {
    overlay.hidden = true;
    overlay.replaceChildren();
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') close();
  };
  cancel.addEventListener('click', close);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (ok.disabled) return;
    ok.disabled = true;
    void d.run().then((err) => {
      if (err === null) close();
      else {
        setText(msg, err);
        ok.disabled = false;
      }
    });
  });
  document.addEventListener('keydown', onKey);
  overlay.replaceChildren(form);
  overlay.hidden = false;
  (form.querySelector('input') ?? ok).focus();
}

function confirmDialog(title: string, text: string, okLabel: string, kind: 'gold' | 'danger', act: () => Promise<string | null>): void {
  dialog({ title, body: [h('p', {}, text)], ok: okLabel, kind, run: act });
}

/** 수정: name, PIN and 잔고. The version the admin saw goes along; a change in between is refused and shown. */
function editDialog(p: AdminPlayer): void {
  let seen = p;
  const name = h('input', { class: 'field', value: p.name, maxlength: PLATFORM.nameMax, 'data-testid': 'edit-name' });
  const pin = h('input', { class: 'field mono', value: p.pin, maxlength: PLATFORM.pinDigits, inputmode: 'numeric', 'data-testid': 'edit-pin' });
  const total = h('input', { class: 'field mono', type: 'number', min: 0, step: 1, value: p.total, 'data-testid': 'edit-total' });
  const now = h('div', { class: 'dlg-note' });
  const showNow = (): void => {
    const lock = seen.held + seen.inGame;
    setText(now, `현재 잔고 ${chips(seen.total)} (사용 가능 ${seen.free} · 정산 대기 ${seen.held} · 게임 중 ${seen.inGame})${lock ? ` · ${lock}칩보다 작게는 못 바꿉니다` : ''}`);
  };
  showNow();
  dialog({
    title: `${p.name} 수정`,
    body: [field('이름', name), field('PIN', pin), field('잔고 (칩)', total), now],
    ok: '저장',
    kind: 'gold',
    run: async () => {
      try {
        await api(BASE, 'admin/edit', { id: p.id, version: seen.version, name: name.value, pin: pin.value, total: Number(total.value) });
        toast(`${name.value.trim()} 수정 완료`, 'good');
        play('coin');
        return null;
      } catch (err) {
        if (err instanceof ApiError && err.code === 'conflict') {
          const latest = state?.players.find((x) => x.id === p.id);
          if (!latest) return '플레이어가 삭제되었습니다';
          seen = latest;
          showNow();
          return `그 사이 바뀌었습니다 (지금 잔고 ${chips(latest.total)}). 확인하고 다시 저장하세요`;
        }
        return err instanceof ApiError ? err.message : '오류가 났습니다';
      }
    },
  });
}

/** 정산 by the admin (the player is at the counter): the chips come off the ledger first, then the physical chips go out. */
function settleDialog(p: AdminPlayer): void {
  const key = requestKey(); // one dialog, one settlement, however many clicks
  const most = Math.min(p.free, p.settleLeft);
  const amount = h('input', { class: 'field mono', type: 'number', min: 1, max: most, step: 1, value: most, 'data-testid': 'settle-amount' });
  dialog({
    title: `${p.name} 정산 (실물 칩 교환)`,
    body: [
      h('p', {}, `사용 가능한 칩 ${chips(p.free)} 중에서 실물 칩으로 바꿔 줄 개수를 적으세요. [정산 확정]으로 장부에서 뺀 뒤에 실물 칩을 건네세요.`),
      h('div', { class: 'dlg-note' }, `실물 칩은 한 사람당 ${PLATFORM.settleMax}개까지: 지금까지 ${p.paidOut}개 받음 · 앞으로 ${p.settleLeft}개`),
      field('바꿀 칩', amount),
      p.held ? h('div', { class: 'dlg-note' }, `이 플레이어는 ${chips(p.held)} 정산 요청을 기다리고 있습니다 (오른쪽 목록)`) : h('span'),
    ],
    ok: '정산 확정',
    kind: 'gold',
    run: async () => {
      try {
        await api(BASE, 'admin/settle', { playerId: p.id, amount: Number(amount.value), key }, { retryMs: 10_000 });
        toast(`확정! ${p.name}에게 실물 ${chips(Number(amount.value))}을 건네세요`, 'good');
        play('cashout');
        return null;
      } catch (err) {
        return err instanceof ApiError ? err.message : '오류가 났습니다';
      }
    },
  });
}

function deleteDialog(p: AdminPlayer): void {
  const lost = [p.held && `정산 대기 ${p.held}`, p.inGame && `게임 중 ${p.inGame}`].filter(Boolean).join(', ');
  dialog({
    title: `${p.name} 계정을 삭제할까요?`,
    body: [
      h('p', {}, `잔고 ${chips(p.total)}${lost ? ` (${lost} 포함)` : ''}이 함께 사라지고, 접속 중이면 바로 로그아웃됩니다.`),
      h('p', { class: 'dlg-note' }, '되돌릴 수 없습니다. 삭제 기록과 그때의 정보는 DB 기록에 남습니다.'),
    ],
    ok: '삭제',
    kind: 'danger',
    run: () => post('delete', { id: p.id }, `${p.name} 삭제 완료`),
  });
}

/** A game that will never report (its PC died): give the stake back, keep it, or pay what the player's screen shows. */
function forceCloseDialog(g: AdminGame, gameName: string): void {
  const payout = h('input', { class: 'field mono', type: 'number', min: 0, step: 1, value: g.stake, 'data-testid': 'force-payout' });
  const quick = (label: string, v: number): HTMLElement =>
    h('button', { class: 'chip-btn', type: 'button', onclick: () => (payout.value = String(v)) }, label);
  dialog({
    title: `${g.name}의 ${gameName} 강제 종료`,
    body: [
      h('p', {}, `${chips(g.stake)}을 걸고 시작한 게임입니다. 플레이어에게 돌려줄 칩을 정하세요.`),
      h('div', { class: 'quick' }, quick(`환불 ${g.stake}칩`, g.stake), quick('몰수 0칩', 0)),
      field('돌려줄 칩', payout),
    ],
    ok: '강제 종료',
    kind: 'danger',
    run: () => post('game/close', { id: g.id, payout: Number(payout.value) }, '게임을 종료했습니다', g.id),
  });
}

function field(label: string, input: HTMLElement): HTMLElement {
  return h('label', { class: 'dlg-field' }, h('span', {}, label), input);
}

function toast(text: string, kind: 'good' | 'bad'): void {
  const el = h('div', { class: `toast ${kind}` }, text);
  toasts.append(el);
  while (toasts.children.length > 4) toasts.firstElementChild?.remove();
  window.setTimeout(() => el.classList.add('out'), 3000);
  window.setTimeout(() => el.remove(), 3500);
}

// Times on screen move on their own (online time, "3분 전").
window.setInterval(() => {
  if (state && connected && tab === 'players') {
    renderPlayers();
    renderRequests();
  }
}, 1000);

setTab('players');
setConnected(false);
connect();
