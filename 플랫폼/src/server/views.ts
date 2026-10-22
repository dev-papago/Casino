// What the player app and the admin screen see of the ledger. Pure functions of the state plus who is online.
import type { AdminState, PlayerRankReply, PlayerView, RankReply } from '../shared/protocol.ts';
import { deathOpenFor, gamesOf, heldOf, inGameOf, settleLeftOf, settlementOf, totalOf, type State } from './ledger.ts';

/** Messages a player sees of their own; messages the admin screen shows besides the unread ones. */
const MY_MESSAGES = 5;
const ADMIN_READ_MESSAGES = 50;

export function playerView(s: State, id: string): PlayerView | null {
  const p = s.players.get(id);
  if (!p) return null;
  const r = settlementOf(s, id);
  return {
    id,
    name: p.name,
    total: totalOf(s, p),
    free: p.chips,
    held: heldOf(s, id),
    inGame: inGameOf(s, id),
    paidOut: p.paidOut,
    settleLeft: settleLeftOf(s, p),
    settlement: r ? { id: r.id, amount: r.amount, requestedAt: r.requestedAt } : null,
    deathGame: deathOpenFor(s, p),
    messages: [...s.messages.values()]
      .filter((m) => m.playerId === id)
      .slice(-MY_MESSAGES)
      .reverse()
      .map(({ id: mid, text, at, read }) => ({ id: mid, text, at, read })),
    games: gamesOf(s, id).map(({ id: gid, game, stake, openedAt, review }) => ({ id: gid, game, stake, openedAt, review: review?.payout ?? null })),
  };
}

/** Presence of a player right now: online, and activity including the time online since it was last saved. */
export interface Live {
  online: boolean;
  lastActiveAt: number;
  activeMs: number;
}

export function adminState(s: State, live: (id: string) => Live | null, at: number, server: AdminState['server']): AdminState {
  const name = (id: string): string => s.players.get(id)?.name ?? '(삭제됨)';
  const players = [...s.players.values()].map((p) => {
    const l = live(p.id);
    return {
      id: p.id,
      name: p.name,
      pin: p.pin,
      total: totalOf(s, p),
      free: p.chips,
      held: heldOf(s, p.id),
      inGame: inGameOf(s, p.id),
      createdAt: p.createdAt,
      lastActiveAt: l?.lastActiveAt ?? p.lastActiveAt,
      activeMs: l?.activeMs ?? p.activeMs,
      online: l?.online ?? false,
      played: p.played,
      net: p.net,
      paidOut: p.paidOut,
      settleLeft: settleLeftOf(s, p),
      version: p.version,
      deathClears: p.deathClears ?? 0,
    };
  });
  return {
    at,
    players,
    settlements: [...s.settlements.values()].map((r) => ({ ...r, name: name(r.playerId) })),
    messages: [
      ...[...s.messages.values()].filter((m) => !m.read).reverse(),
      ...[...s.messages.values()].filter((m) => m.read).slice(-ADMIN_READ_MESSAGES).reverse(),
    ].map((m) => ({ ...m, name: name(m.playerId) })),
    games: [...s.games.values()].map(({ id, playerId, game, stake, openedAt, online, review }) => ({
      id,
      playerId,
      game,
      stake,
      openedAt,
      online: !!online,
      review: review?.payout ?? null,
      name: name(playerId),
    })),
    totals: { ...s.totals, outstanding: players.reduce((t, p) => t + p.total, 0) },
    server,
  };
}

/** Every player by 잔고, highest first (ties: more physical chips received, then the name). */
function ranked(s: State, online: (id: string) => boolean) {
  return [...s.players.values()]
    .map((p) => ({ id: p.id, name: p.name, total: totalOf(s, p), paidOut: p.paidOut, played: p.played, net: p.net, online: online(p.id) }))
    .sort((a, b) => b.total - a.total || b.paidOut - a.paidOut || a.name.localeCompare(b.name, 'ko'));
}

/** The 순위 대시보드 on the admin PC (/rank). */
export function rankView(s: State, online: (id: string) => boolean, at: number): RankReply {
  const rows = ranked(s, online).map(({ id: _id, ...r }) => r);
  return { at, rows, players: rows.length, outstanding: rows.reduce((t, r) => t + r.total, 0), settled: s.totals.settled };
}

/** The ranking in the player app: the top PLAYER_RANK_ROWS and where this player stands. */
export function playerRankView(s: State, online: (id: string) => boolean, id: string, top = PLAYER_RANK_ROWS): PlayerRankReply {
  const all = ranked(s, online);
  const mine = all.findIndex((r) => r.id === id);
  return {
    rows: all.slice(0, top).map((r) => ({ name: r.name, total: r.total, online: r.online, me: r.id === id })),
    me: mine < 0 ? null : { rank: mine + 1, total: all[mine].total },
    players: all.length,
  };
}

export const PLAYER_RANK_ROWS = 10;
