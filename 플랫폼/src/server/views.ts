// What the player app and the admin screen see of the ledger. Pure functions of the state plus who is online.
import type { AdminState, PlayerView } from '../shared/protocol.ts';
import { bankruptcyOf, gamesOf, heldOf, inGameOf, settlementOf, totalOf, type State } from './ledger.ts';

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
    settlement: r ? { id: r.id, amount: r.amount, requestedAt: r.requestedAt } : null,
    bankrupt: !!bankruptcyOf(s, id),
    games: gamesOf(s, id).map(({ id: gid, game, stake, openedAt }) => ({ id: gid, game, stake, openedAt })),
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
      version: p.version,
      bankrupt: !!bankruptcyOf(s, p.id),
    };
  });
  return {
    at,
    players,
    settlements: [...s.settlements.values()].map((r) => ({ ...r, name: name(r.playerId) })),
    bankruptcies: [...s.bankruptcies.values()].map((b) => ({ ...b, name: name(b.playerId) })),
    games: [...s.games.values()].map(({ secret: _secret, ...g }) => ({ ...g, name: name(g.playerId) })),
    totals: { ...s.totals, outstanding: players.reduce((t, p) => t + p.total, 0) },
    server,
  };
}
