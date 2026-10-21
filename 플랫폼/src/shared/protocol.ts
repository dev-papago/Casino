// What the ledger server, the player app and the admin screen send each other (DESIGN.md section 4).
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
  | 'closed'
  | 'forbidden'
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
  closed: '이미 정산된 게임입니다',
  forbidden: '관리자 PC에서만 할 수 있습니다',
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
}

/** Everything the player app shows about the logged-in player. */
export interface PlayerView {
  id: string;
  name: string;
  total: number; // 잔고: free + held + inGame
  free: number; // free to use
  held: number; // held for the pending settlement request
  inGame: number; // staked in open game sessions
  settlement: { id: string; amount: number; requestedAt: number } | null;
  bankrupt: boolean; // a bankruptcy request is waiting for the admin
  games: GameSessionView[];
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
  | 'gameOpen'
  | 'gameClose'
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
  bankrupt: '파산 신청',
  bankruptDone: '파산 처리',
  gameOpen: '게임 입장',
  gameClose: '게임 정산',
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
  version: number;
  bankrupt: boolean;
}

export interface AdminSettlement {
  id: string;
  playerId: string;
  name: string;
  amount: number;
  requestedAt: number;
}

export interface AdminBankruptcy {
  id: string;
  playerId: string;
  name: string;
  filedAt: number;
}

export interface AdminGame extends GameSessionView {
  playerId: string;
  name: string;
}

/** An address of the admin PC that player PCs can open, with the network it is on (Wi-Fi, 이더넷, …). */
export interface LanUrl {
  name: string;
  url: string;
}

export interface AdminState {
  at: number;
  players: AdminPlayer[];
  settlements: AdminSettlement[];
  bankruptcies: AdminBankruptcy[];
  games: AdminGame[];
  // Chips given at signup, net admin edits, net game results, paid out at the counter, lost with deleted accounts,
  // and still owed to players. outstanding = bonus + edits + games − settled − deleted, always.
  totals: { bonus: number; edits: number; games: number; settled: number; deleted: number; outstanding: number };
  server: { urls: LanUrl[]; dataDir: string; startedAt: number };
}

/** Server-sent events on /api/admin/events: a full snapshot first, then only what changed and the new log lines. */
export interface AdminEvents {
  snapshot: AdminState & { log: LogRecord[] };
  update: AdminState & { log: LogRecord[] };
}
