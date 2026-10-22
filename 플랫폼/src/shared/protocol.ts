// What the ledger server, the player app and the admin screen send each other.
// Requests and answers are JSON over HTTP; live updates come as server-sent events.
import type { GameId } from './config.ts';

export type ErrorCode =
  | 'bad_request'
  | 'name'
  | 'name_taken'
  | 'pin'
  | 'login'
  | 'locked'
  | 'session'
  | 'amount'
  | 'funds'
  | 'held'
  | 'pending'
  | 'gone'
  | 'conflict'
  | 'unchanged'
  | 'game'
  | 'payout'
  | 'settle_cap'
  | 'closed'
  | 'review'
  | 'entry'
  | 'entry_locked'
  | 'busy'
  | 'forbidden'
  | 'death_rich'
  | 'death_run'
  | 'message'
  | 'not_found';

export const ERROR_TEXT: Record<ErrorCode, string> = {
  bad_request: '잘못된 요청입니다',
  name: '이름은 1~12글자로 입력하세요',
  name_taken: '이미 있는 이름입니다',
  pin: 'PIN은 숫자 4자리입니다',
  login: '이름 또는 PIN이 맞지 않습니다',
  locked: 'PIN을 여러 번 틀렸습니다. 잠시 뒤에 다시 하세요',
  session: '다시 로그인하세요',
  amount: '칩 개수를 확인하세요',
  funds: '칩이 부족합니다',
  held: '정산 대기나 게임 중인 칩보다 적게 바꿀 수 없습니다',
  pending: '처리를 기다리는 정산 요청이 있습니다',
  gone: '이미 처리되었거나 없는 요청입니다',
  conflict: '그 사이 값이 바뀌었습니다. 확인하고 다시 하세요',
  unchanged: '바뀐 값이 없습니다',
  game: '알 수 없는 게임입니다',
  payout: '게임 결과가 한도를 넘습니다. 관리자에게 문의하세요',
  settle_cap: '실물 칩은 한 사람당 축제 동안 50개까지만 받을 수 있습니다',
  closed: '이미 정산된 게임입니다',
  review: '관리자가 확인하고 있는 게임입니다',
  entry: '입장 코드가 맞지 않습니다. 행사장에서 안내한 코드를 넣으세요',
  entry_locked: '입장 코드를 여러 번 틀렸습니다. 2분 뒤에 다시 하세요',
  busy: '요청이 너무 많습니다. 잠시 뒤에 다시 하세요',
  forbidden: '관리자 PC에서만 할 수 있습니다',
  death_rich: '잔고가 0칩일 때만 데스 게임에 도전할 수 있습니다',
  death_run: '데스 게임 진행 기록이 맞지 않습니다. 처음부터 다시 도전하세요',
  message: '메시지는 1~200글자로 적으세요',
  not_found: '없는 플레이어입니다',
};

export interface ErrorBody {
  error: ErrorCode;
  message: string;
}

// ------------------------------------------------------------------ player app

export interface GameSessionView {
  id: string;
  game: GameId;
  stake: number;
  openedAt: number;
  review: number | null; // 온라인판: the payout the game reported, waiting for the admin
}

/** Everything the player app shows about the logged-in player. */
export interface PlayerView {
  id: string;
  name: string;
  total: number; // 잔고: free + held + inGame
  free: number; // free to use
  held: number; // held for the pending settlement request
  inGame: number; // staked in open game sessions
  paidOut: number; // physical chips received so far
  settleLeft: number; // physical chips this player can still receive (PLATFORM.settleMax in all)
  settlement: { id: string; amount: number; requestedAt: number } | null;
  deathGame: boolean; // no chips at all: the 데스 게임 pays out
  messages: { id: string; text: string; at: number; read: boolean }[]; // sent to the admin, newest first
  games: GameSessionView[];
}

/** POST /api/death/start: the run the server follows; its stages are reported as they are cleared. */
export interface DeathStartReply {
  run: string;
}

export interface AuthReply {
  token: string;
  me: PlayerView;
}

export interface MeReply {
  me: PlayerView;
}

/** A game session the player app opened: `secret` closes it, even after a logout or from another login. */
export interface GameOpenReply extends MeReply {
  session: GameSessionView & { secret: string };
}

/** GET /api/hello: how this address works. Through the tunnel there are no live updates and an 입장 코드 is asked. */
export interface Hello {
  online: boolean;
  pingMs: number;
  entryDigits: number; // 0: no 입장 코드
}

/** POST /api/game/close: `review` when a big online win waits for the admin instead of paying out at once. */
export interface GameCloseReply {
  me: PlayerView | null;
  review: boolean;
}

/** Server-sent events on /api/events. */
export interface PlayerEvents {
  me: PlayerView;
  kicked: { reason: string };
}

// ------------------------------------------------------------------ admin screen

export type LogKind =
  | 'signup'
  | 'edit'
  | 'delete'
  | 'settleRequest'
  | 'settleCancel'
  | 'settleReject'
  | 'settleDone'
  | 'settleDirect'
  | 'bankrupt'
  | 'bankruptDone'
  | 'deathClear'
  | 'gameOpen'
  | 'gameClose'
  | 'gameReview'
  | 'gameForce';

export const LOG_LABEL: Record<LogKind, string> = {
  signup: '가입',
  edit: '수정',
  delete: '삭제',
  settleRequest: '정산 요청',
  settleCancel: '정산 취소',
  settleReject: '정산 거절',
  settleDone: '정산 완료',
  settleDirect: '관리자 정산',
  bankrupt: '파산',
  bankruptDone: '파산 처리',
  deathClear: '데스 게임 통과',
  gameOpen: '게임 입장',
  gameClose: '게임 정산',
  gameReview: '지급 확인 요청',
  gameForce: '게임 강제 종료',
};

/** Game entries and exits are everyday traffic; the DB 기록 window shows the rest unless asked for everything. */
export const GAME_KINDS: ReadonlySet<LogKind> = new Set(['gameOpen', 'gameClose']);

/** One line of the DB 기록 window. */
export interface LogRecord {
  seq: number;
  at: number;
  kind: LogKind;
  playerId: string;
  name: string; // the player's name at that moment
  delta: number; // change of the player's 잔고 (free + held + staked)
  chips: number; // 잔고 after it
  text: string;
}

export interface AdminPlayer {
  id: string;
  name: string;
  pin: string;
  total: number; // 잔고 (what an edit sets)
  free: number;
  held: number;
  inGame: number;
  createdAt: number;
  lastActiveAt: number;
  activeMs: number; // total time online
  online: boolean;
  played: number; // game sessions finished
  net: number; // chips won (+) or lost (−) in them
  paidOut: number; // physical chips handed over
  settleLeft: number; // physical chips still allowed (PLATFORM.settleMax in all)
  version: number;
  deathClears: number; // 데스 게임 cleared (each paid PLATFORM.deathGame.reward)
}

export interface AdminSettlement {
  id: string;
  playerId: string;
  name: string;
  amount: number;
  requestedAt: number;
}

/** A player's message to the admin. */
export interface AdminMessage {
  id: string;
  playerId: string;
  name: string;
  text: string;
  at: number;
  read: boolean;
}

export interface AdminGame extends GameSessionView {
  playerId: string;
  name: string;
  online: boolean; // opened through the tunnel
}

/** The tunnel as the admin screen shows it (null: this server runs without one). */
export interface AdminOnline {
  status: 'starting' | 'up' | 'restarting' | 'stopped';
  url: string | null; // https://….trycloudflare.com, changes whenever cloudflared starts again
  message: string; // what is going on, in Korean
  code: string; // 입장 코드
}

export interface AdminState {
  at: number;
  players: AdminPlayer[];
  settlements: AdminSettlement[];
  messages: AdminMessage[]; // unread first, then the latest read ones
  games: AdminGame[];
  // Chips given (signup, 데스 게임), net admin edits, net game results, paid out at the counter, lost with deleted accounts,
  // and still owed to players. outstanding = bonus + edits + games − settled − deleted, always.
  totals: { bonus: number; edits: number; games: number; settled: number; deleted: number; outstanding: number };
  server: { dataDir: string; startedAt: number; online: AdminOnline | null };
}

/** Server-sent events on /api/admin/events: a full snapshot first, then only what changed and the new log lines. */
export interface AdminEvents {
  snapshot: AdminState & { log: LogRecord[] };
  update: AdminState & { log: LogRecord[] };
}

// ------------------------------------------------------------------ 순위 대시보드 (admin PC: /rank)

export interface RankRow {
  name: string;
  total: number; // 잔고
  paidOut: number; // physical chips received
  played: number;
  net: number;
  online: boolean;
}

export interface RankReply {
  at: number;
  rows: RankRow[]; // by 잔고, highest first
  players: number;
  outstanding: number; // all 잔고 together
  settled: number; // physical chips handed over in all
}

/** The ranking beside the player app: the top players and this player's place. */
export interface PlayerRankReply {
  rows: { name: string; total: number; online: boolean; me: boolean }[];
  me: { rank: number; total: number } | null;
  players: number;
}
