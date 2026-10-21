// The chip ledger (DESIGN.md section 2). Pure: a command checks the current state and returns one event, and
// apply() folds an event into the state. The server writes every event to the journal before applying it and
// replays the journal on start, so the state is always exactly the events so far. One command is one event:
// a crash can never leave half a command behind.
//
// A player's chips are in one of three places: free (`chips`), held for a settlement request (until the admin
// hands over the physical chips or turns the request down), or staked in an open game session (until the game
// reports its result). Their sum is the player's 잔고. Nothing ever goes below zero. Chips come in by the signup
// bonus, admin edits and game wins, and go out by settlements (physical chips), admin edits, game losses and
// deleting an account; `totals` counts each, so the ledger can always be checked against itself.
//
// Requests that may be sent twice (a lost answer on a shaky Wi-Fi) carry a key: the same key gets the first
// event back instead of doing the thing again.
import { randomBytes } from 'node:crypto';
import { PLATFORM, gameDef, type GameId } from '../shared/config.ts';
import type { ErrorCode, LogKind, LogRecord } from '../shared/protocol.ts';

export interface Player {
  id: string;
  name: string;
  pin: string;
  chips: number; // free to use
  createdAt: number;
  lastActiveAt: number;
  activeMs: number; // time online, as last saved
  played: number; // game sessions finished
  net: number; // chips won (+) or lost (−) in them
  version: number; // bumps whenever the player's chips, name or PIN change; an admin edit names the version it saw
  login: string; // secret of the current login ('' = logged out); a new login ends the old one
}

export interface GameSession {
  id: string;
  playerId: string;
  game: GameId;
  stake: number;
  openedAt: number;
  secret: string; // closes the session; the game keeps it, so it can report even after a logout
}

export interface Settlement {
  id: string;
  playerId: string;
  amount: number;
  requestedAt: number;
}

export interface Bankruptcy {
  id: string;
  playerId: string;
  filedAt: number;
}

/** What an admin edit changes: name, PIN and 잔고 (all of the player's chips). */
export interface Editable {
  name: string;
  pin: string;
  total: number;
}

export type EventBody =
  | { type: 'signup'; key: string; player: { id: string; name: string; pin: string; login: string }; bonus: number }
  | { type: 'login'; key: string; id: string; login: string }
  | { type: 'logout'; id: string }
  | { type: 'activity'; id: string; lastActiveAt: number; activeMs: number }
  | { type: 'edit'; id: string; before: Editable; after: Editable; bankruptcy: string | null }
  | { type: 'delete'; id: string; player: Player; games: GameSession[]; settlement: Settlement | null; bankruptcy: string | null }
  | { type: 'gameOpen'; key: string; session: Omit<GameSession, 'openedAt'> }
  | { type: 'gameClose'; id: string; playerId: string; payout: number; by: 'player' | 'admin'; bankruptcy: string | null }
  | { type: 'settleRequest'; key: string; settlement: Omit<Settlement, 'requestedAt'> }
  | { type: 'settleCancel'; id: string; playerId: string; by: 'player' | 'admin' }
  | { type: 'settleDone'; id: string; playerId: string }
  | { type: 'settleDirect'; key: string; id: string; playerId: string; amount: number }
  | { type: 'bankruptDone'; id: string; playerId: string };

export type LedgerEvent = EventBody & { seq: number; at: number };

/** A command's result: a new event to write, or the event an earlier request with the same key already made. */
export type Outcome = EventBody | LedgerEvent;

export interface State {
  seq: number;
  players: Map<string, Player>;
  names: Map<string, string>; // nameKey → player id
  games: Map<string, GameSession>; // open sessions
  closed: Map<string, { secret: string; event: LedgerEvent }>; // finished sessions, for a repeated report
  settlements: Map<string, Settlement>; // pending requests
  bankruptcies: Map<string, Bankruptcy>; // waiting for the admin
  keys: Map<string, LedgerEvent>; // request key → the event it made
  log: LogRecord[]; // the DB 기록 window
  totals: { bonus: number; edits: number; games: number; settled: number; deleted: number };
}

export class LedgerError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode) {
    super(code);
    this.code = code;
  }
}

export function emptyState(): State {
  return {
    seq: 0,
    players: new Map(),
    names: new Map(),
    games: new Map(),
    closed: new Map(),
    settlements: new Map(),
    bankruptcies: new Map(),
    keys: new Map(),
    log: [],
    totals: { bonus: 0, edits: 0, games: 0, settled: 0, deleted: 0 },
  };
}

// ------------------------------------------------------------------ checks

export const newId = (): string => randomBytes(9).toString('base64url');
export const newSecret = (): string => randomBytes(18).toString('base64url');

/** Display form of a name: NFC, single spaces, trimmed. */
export const cleanName = (raw: unknown): string =>
  typeof raw === 'string' ? raw.normalize('NFC').replace(/\s+/g, ' ').trim() : '';
/** Case and spacing do not make a different player. */
export const nameKey = (name: string): string => cleanName(name).toLowerCase();

function checkName(raw: unknown): string {
  const name = cleanName(raw);
  if (!name || [...name].length > PLATFORM.nameMax || /[\u0000-\u001f\u007f]/.test(name)) throw new LedgerError('name');
  return name;
}

const PIN = new RegExp(`^\\d{${PLATFORM.pinDigits}}$`);
function checkPin(raw: unknown): string {
  const pin = typeof raw === 'number' ? String(raw) : raw;
  if (typeof pin !== 'string' || !PIN.test(pin)) throw new LedgerError('pin');
  return pin;
}

/** A whole number of chips from `min` up to the sanity limit. */
function checkChips(raw: unknown, min: number): number {
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < min || raw > PLATFORM.maxChips) {
    throw new LedgerError('amount');
  }
  return raw;
}

function player(s: State, id: unknown): Player {
  const p = typeof id === 'string' ? s.players.get(id) : undefined;
  if (!p) throw new LedgerError('not_found');
  return p;
}

/** The event an earlier request with this key made, if it was the same kind of request by the same player. */
function replay(s: State, key: string, type: EventBody['type'], same: (e: LedgerEvent) => boolean): LedgerEvent | null {
  const e = s.keys.get(key);
  if (!e) return null;
  if (e.type !== type || !same(e)) throw new LedgerError('bad_request');
  return e;
}

// ------------------------------------------------------------------ where the chips are

export const settlementOf = (s: State, playerId: string): Settlement | undefined =>
  [...s.settlements.values()].find((r) => r.playerId === playerId);
export const bankruptcyOf = (s: State, playerId: string): Bankruptcy | undefined =>
  [...s.bankruptcies.values()].find((b) => b.playerId === playerId);
export const gamesOf = (s: State, playerId: string): GameSession[] =>
  [...s.games.values()].filter((g) => g.playerId === playerId);
export const heldOf = (s: State, playerId: string): number => settlementOf(s, playerId)?.amount ?? 0;
export const inGameOf = (s: State, playerId: string): number => gamesOf(s, playerId).reduce((t, g) => t + g.stake, 0);
/** 잔고: free + held + staked. */
export const totalOf = (s: State, p: Player): number => p.chips + heldOf(s, p.id) + inGameOf(s, p.id);

// ------------------------------------------------------------------ commands

export function signup(s: State, input: { name: unknown; pin: unknown; key: string }): Outcome {
  const name = checkName(input.name);
  const done = replay(s, input.key, 'signup', (e) => e.type === 'signup' && nameKey(e.player.name) === nameKey(name));
  if (done) return done;
  if (s.names.has(nameKey(name))) throw new LedgerError('name_taken');
  const pin = checkPin(input.pin);
  return { type: 'signup', key: input.key, player: { id: newId(), name, pin, login: newSecret() }, bonus: PLATFORM.signupBonus };
}

export function login(s: State, input: { name: unknown; pin: unknown; key: string }): Outcome {
  const id = s.names.get(nameKey(cleanName(input.name)));
  const done = replay(s, input.key, 'login', (e) => e.type === 'login' && e.id === id);
  if (done) return done;
  const p = id ? s.players.get(id) : undefined;
  if (!p || p.pin !== (typeof input.pin === 'number' ? String(input.pin) : input.pin)) throw new LedgerError('login');
  return { type: 'login', key: input.key, id: p.id, login: newSecret() };
}

export function logout(s: State, id: string): EventBody {
  return { type: 'logout', id: player(s, id).id };
}

export function activity(s: State, input: { id: string; lastActiveAt: number; activeMs: number }): EventBody {
  const p = player(s, input.id);
  return { type: 'activity', id: p.id, lastActiveAt: Math.round(input.lastActiveAt), activeMs: Math.round(input.activeMs) };
}

/** Admin edit of name, PIN and 잔고. It must name the version it was looking at, so it never undoes a change it did not see. */
export function edit(s: State, input: { id: unknown; version: unknown; name: unknown; pin: unknown; total: unknown }): EventBody {
  const p = player(s, input.id);
  if (input.version !== p.version) throw new LedgerError('conflict');
  const name = checkName(input.name);
  const other = s.names.get(nameKey(name));
  if (other && other !== p.id) throw new LedgerError('name_taken');
  const pin = checkPin(input.pin);
  const total = checkChips(input.total, 0);
  const before: Editable = { name: p.name, pin: p.pin, total: totalOf(s, p) };
  // Held and staked chips are not the admin's to take here: 잔고 cannot go below them.
  if (total < before.total - p.chips) throw new LedgerError('held');
  if (name === before.name && pin === before.pin && total === before.total) throw new LedgerError('unchanged');
  const b = bankruptcyOf(s, p.id);
  return { type: 'edit', id: p.id, before, after: { name, pin, total }, bankruptcy: b && total > 0 ? b.id : null };
}

/** Deletes the account and everything in it: free, held and staked chips. */
export function remove(s: State, id: unknown): EventBody {
  const p = player(s, id);
  return {
    type: 'delete',
    id: p.id,
    player: { ...p },
    games: gamesOf(s, p.id),
    settlement: settlementOf(s, p.id) ?? null,
    bankruptcy: bankruptcyOf(s, p.id)?.id ?? null,
  };
}

/** A game takes its stake out of the free chips; the game then plays without the network until it reports. */
export function openGame(s: State, input: { playerId: string; game: unknown; stake: unknown; key: string }): Outcome {
  const done = replay(s, input.key, 'gameOpen', (e) => e.type === 'gameOpen' && e.session.playerId === input.playerId);
  if (done) return done;
  const p = player(s, input.playerId);
  const def = typeof input.game === 'string' ? gameDef(input.game) : undefined;
  if (!def) throw new LedgerError('game');
  const stake = checkChips(input.stake, 1);
  if (stake > p.chips) throw new LedgerError('funds');
  return { type: 'gameOpen', key: input.key, session: { id: newId(), playerId: p.id, game: def.id, stake, secret: newSecret() } };
}

/**
 * The game's result. A player's report needs the session secret and stays within the game's limit; the admin can
 * close a session that will never report (a PC that died mid-game) with any payout: the stake back, nothing, or
 * what the player shows on screen. A session that ends with the player out of chips files for bankruptcy.
 */
export function closeGame(s: State, input: { id: unknown; payout: unknown; secret?: unknown; by: 'player' | 'admin' }): Outcome {
  const id = typeof input.id === 'string' ? input.id : '';
  const done = s.closed.get(id);
  if (done) {
    const e = done.event;
    if (input.by === 'player' && input.secret === done.secret && e.type === 'gameClose' && e.payout === input.payout) return e;
    throw new LedgerError('closed');
  }
  const g = s.games.get(id);
  if (!g) throw new LedgerError('gone');
  if (input.by === 'player' && input.secret !== g.secret) throw new LedgerError('session');
  const payout = checkChips(input.payout, 0);
  const def = gameDef(g.game);
  if (input.by === 'player' && def && payout > Math.max(g.stake, def.maxPayout)) throw new LedgerError('payout');
  const p = player(s, g.playerId);
  const broke =
    p.chips + payout <= 0 && gamesOf(s, p.id).length === 1 && !settlementOf(s, p.id) && !bankruptcyOf(s, p.id);
  return { type: 'gameClose', id, playerId: p.id, payout, by: input.by, bankruptcy: broke ? newId() : null };
}

/** 정산 요청: the chips are held at once, so they cannot be played away while the admin gets the physical chips. */
export function requestSettlement(s: State, input: { playerId: string; amount: unknown; key: string }): Outcome {
  const done = replay(s, input.key, 'settleRequest', (e) => e.type === 'settleRequest' && e.settlement.playerId === input.playerId);
  if (done) return done;
  const p = player(s, input.playerId);
  if (settlementOf(s, p.id)) throw new LedgerError('pending');
  const amount = checkChips(input.amount, 1);
  if (amount > p.chips) throw new LedgerError('funds');
  return { type: 'settleRequest', key: input.key, settlement: { id: newId(), playerId: p.id, amount } };
}

/** The player takes the request back, or the admin turns it down: the held chips are free again. */
export function cancelSettlement(s: State, input: { id: unknown; by: 'player' | 'admin'; playerId?: string }): EventBody {
  const r = typeof input.id === 'string' ? s.settlements.get(input.id) : undefined;
  if (!r || (input.by === 'player' && r.playerId !== input.playerId)) throw new LedgerError('gone');
  return { type: 'settleCancel', id: r.id, playerId: r.playerId, by: input.by };
}

/** The admin handed over the physical chips: the held chips leave the ledger. */
export function completeSettlement(s: State, id: unknown): EventBody {
  const r = typeof id === 'string' ? s.settlements.get(id) : undefined;
  if (!r) throw new LedgerError('gone');
  return { type: 'settleDone', id: r.id, playerId: r.playerId };
}

/** The admin settles without a request (the player is at the counter): straight out of the free chips. */
export function directSettlement(s: State, input: { playerId: unknown; amount: unknown; key: string }): Outcome {
  const done = replay(s, input.key, 'settleDirect', (e) => e.type === 'settleDirect' && e.playerId === input.playerId);
  if (done) return done;
  const p = player(s, input.playerId);
  const amount = checkChips(input.amount, 1);
  if (amount > p.chips) throw new LedgerError('funds');
  return { type: 'settleDirect', key: input.key, id: newId(), playerId: p.id, amount };
}

export function resolveBankruptcy(s: State, id: unknown): EventBody {
  const b = typeof id === 'string' ? s.bankruptcies.get(id) : undefined;
  if (!b) throw new LedgerError('gone');
  return { type: 'bankruptDone', id: b.id, playerId: b.playerId };
}

// ------------------------------------------------------------------ apply

export function apply(s: State, e: LedgerEvent): void {
  if (e.seq !== s.seq + 1) throw new Error(`장부 순서가 맞지 않습니다: ${s.seq} 다음에 ${e.seq}`);
  s.seq = e.seq;
  if ('key' in e && e.key) s.keys.set(e.key, e);
  switch (e.type) {
    case 'signup': {
      const p: Player = { ...e.player, chips: e.bonus, createdAt: e.at, lastActiveAt: e.at, activeMs: 0, played: 0, net: 0, version: 1 };
      s.players.set(p.id, p);
      s.names.set(nameKey(p.name), p.id);
      s.totals.bonus += e.bonus;
      log(s, e, 'signup', p, e.bonus, `가입 · 보너스 ${e.bonus}칩`);
      break;
    }
    case 'login':
      must(s, e.id).login = e.login;
      break;
    case 'logout':
      must(s, e.id).login = '';
      break;
    case 'activity': {
      const p = must(s, e.id);
      p.lastActiveAt = e.lastActiveAt;
      p.activeMs = e.activeMs;
      break;
    }
    case 'edit': {
      const p = must(s, e.id);
      const delta = e.after.total - e.before.total;
      s.names.delete(nameKey(p.name));
      p.name = e.after.name;
      p.pin = e.after.pin;
      p.chips += delta;
      p.version++;
      s.names.set(nameKey(p.name), p.id);
      s.totals.edits += delta;
      if (e.bankruptcy) s.bankruptcies.delete(e.bankruptcy);
      log(s, e, 'edit', p, delta, editText(e.before, e.after) + (e.bankruptcy ? ' · 파산 해제' : ''));
      break;
    }
    case 'delete': {
      const p = must(s, e.id);
      const total = totalOf(s, p);
      const parts = [heldOf(s, p.id) && `정산 대기 ${heldOf(s, p.id)}`, inGameOf(s, p.id) && `게임 중 ${inGameOf(s, p.id)}`].filter(Boolean);
      log(s, e, 'delete', p, -total, `계정 삭제 · 잔고 ${total}칩${parts.length ? ` (${parts.join(', ')} 포함)` : ''} 소멸`, 0);
      for (const g of e.games) s.games.delete(g.id);
      if (e.settlement) s.settlements.delete(e.settlement.id);
      if (e.bankruptcy) s.bankruptcies.delete(e.bankruptcy);
      s.names.delete(nameKey(p.name));
      s.players.delete(p.id);
      s.totals.deleted += total;
      break;
    }
    case 'gameOpen': {
      const p = must(s, e.session.playerId);
      p.chips -= e.session.stake;
      p.version++;
      s.games.set(e.session.id, { ...e.session, openedAt: e.at });
      log(s, e, 'gameOpen', p, 0, `${gameName(e.session.game)} 입장 · ${e.session.stake}칩을 걸고 시작`);
      break;
    }
    case 'gameClose': {
      const g = s.games.get(e.id);
      if (!g) throw new Error(`장부에 없는 게임 ${e.id}`);
      const p = must(s, g.playerId);
      p.chips += e.payout;
      p.played++;
      p.net += e.payout - g.stake;
      p.version++;
      s.games.delete(g.id);
      s.closed.set(g.id, { secret: g.secret, event: e });
      s.totals.games += e.payout - g.stake;
      const how = e.by === 'admin' ? (e.payout === g.stake ? ' (환불)' : e.payout === 0 ? ' (몰수)' : '') : '';
      log(s, e, e.by === 'admin' ? 'gameForce' : 'gameClose', p, e.payout - g.stake, `${gameName(g.game)} ${e.by === 'admin' ? '강제 종료' : '정산'} · ${g.stake}칩 → ${e.payout}칩${how}`);
      if (e.bankruptcy) {
        s.bankruptcies.set(e.bankruptcy, { id: e.bankruptcy, playerId: p.id, filedAt: e.at });
        log(s, e, 'bankrupt', p, 0, '잔고 0칩 · 자동 파산 신청');
      }
      break;
    }
    case 'settleRequest': {
      const p = must(s, e.settlement.playerId);
      p.chips -= e.settlement.amount;
      p.version++;
      s.settlements.set(e.settlement.id, { ...e.settlement, requestedAt: e.at });
      log(s, e, 'settleRequest', p, 0, `실물 ${e.settlement.amount}칩 정산 요청 (지급 대기)`);
      break;
    }
    case 'settleCancel': {
      const r = mustSettlement(s, e.id);
      const p = must(s, r.playerId);
      p.chips += r.amount;
      p.version++;
      s.settlements.delete(r.id);
      const who = e.by === 'admin' ? '정산 거절' : '정산 요청 취소';
      log(s, e, e.by === 'admin' ? 'settleReject' : 'settleCancel', p, 0, `${who} · ${r.amount}칩 다시 사용 가능`);
      break;
    }
    case 'settleDone': {
      const r = mustSettlement(s, e.id);
      const p = must(s, r.playerId);
      p.version++;
      s.settlements.delete(r.id);
      s.totals.settled += r.amount;
      log(s, e, 'settleDone', p, -r.amount, `실물 ${r.amount}칩 지급 완료`);
      break;
    }
    case 'settleDirect': {
      const p = must(s, e.playerId);
      p.chips -= e.amount;
      p.version++;
      s.totals.settled += e.amount;
      log(s, e, 'settleDirect', p, -e.amount, `실물 ${e.amount}칩 지급 (관리자가 바로 정산)`);
      break;
    }
    case 'bankruptDone': {
      const p = must(s, e.playerId);
      s.bankruptcies.delete(e.id);
      log(s, e, 'bankruptDone', p, 0, '파산 처리 완료');
      break;
    }
  }
  for (const p of s.players.values()) if (p.chips < 0) throw new Error(`${p.name}의 칩이 음수가 되었습니다 (${e.seq}번)`);
}

function must(s: State, id: string): Player {
  const p = s.players.get(id);
  if (!p) throw new Error(`장부에 없는 플레이어 ${id}`);
  return p;
}

function mustSettlement(s: State, id: string): Settlement {
  const r = s.settlements.get(id);
  if (!r) throw new Error(`장부에 없는 정산 요청 ${id}`);
  return r;
}

const gameName = (id: GameId): string => gameDef(id)?.name ?? id;

function editText(a: Editable, b: Editable): string {
  const parts: string[] = [];
  if (a.total !== b.total) parts.push(`잔고 ${a.total} → ${b.total}칩`);
  if (a.name !== b.name) parts.push(`이름 ${a.name} → ${b.name}`);
  if (a.pin !== b.pin) parts.push(`PIN ${a.pin} → ${b.pin}`);
  return parts.join(' · ');
}

function log(s: State, e: LedgerEvent, kind: LogKind, p: Player, delta: number, text: string, chips = totalOf(s, p)): void {
  s.log.push({ seq: e.seq, at: e.at, kind, playerId: p.id, name: p.name, delta, chips, text });
}
