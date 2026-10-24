// 러시안 룰렛 (1대1): the rooms and the games, run by the server in memory. A room's creator puts up the stake
// and picks the lives; a second player who puts up the same stake starts the game. Every round the revolver's
// six chambers are loaded with live and blank rounds in a secret order (only how many of each is told), a coin
// decides who starts, and the player whose turn it is shoots either themselves or the other player (within
// PLATFORM.roulette.turnMs, else at themselves): a blank at yourself keeps the turn, anything else passes it,
// and a live round costs a life. An empty cylinder is reloaded for the next round. The last one standing (or the
// one left when the other gives up or goes away) takes both stakes.
//
// The players' games only send what they choose and ask for news; everything else happens here, on the clock
// (tick). The stakes are ledger sessions the server opens; the end closes them in one ledger event (endDuel).
// A restart forgets the rooms: their sessions are given back (refundOrphans).
import { randomInt, randomUUID } from 'node:crypto';
import { PLATFORM } from '../shared/config.ts';
import type { RouletteEvent, RouletteRoomInfo, RouletteView } from '../shared/protocol.ts';
import { LedgerError, type DuelReason } from './ledger.ts';

export type RouletteTiming = typeof PLATFORM.roulette;

/** An event before it gets its number. */
type Unnumbered<E> = E extends unknown ? Omit<E, 'n'> : never;

/** What the hall needs from the ledger. */
export interface DuelLedger {
  /** Takes the stake out of the player's free chips into a new session; throws LedgerError. */
  stake(playerId: string, stake: number, key: string): string;
  /** Closes the sessions with these payouts (they add up to the stakes). */
  settle(reason: DuelReason, closes: { session: string; payout: number }[]): void;
  /** False once a session is closed some other way (the admin's 강제 종료). */
  open(session: string): boolean;
}

interface Seat {
  id: string;
  name: string;
  session: string;
  lives: number;
  seen: number; // the player's game last asked for news
}

type Phase = 'waiting' | 'load' | 'coin' | 'turn' | 'shot' | 'over';

interface Room {
  id: string;
  stake: number;
  lives: number;
  createdAt: number;
  seats: Seat[]; // [creator] while waiting, [creator, guest] from the start
  phase: Phase;
  until: number; // the current phase ends (in 'turn': the deadline)
  round: number;
  chambers: boolean[]; // still to be fired, in order (true: live). Secret.
  turn: number; // whose turn: 0 or 1
  next: 'turn' | 'load' | 'end'; // after the shot on screen
  winner: number | null;
  reason: DuelReason | null;
  events: RouletteEvent[];
}

export class RouletteHall {
  private readonly rooms = new Map<string, Room>();
  private readonly T: RouletteTiming;
  private readonly ledger: DuelLedger;
  private readonly clock: () => number;

  constructor(ledger: DuelLedger, clock: () => number, timing: Partial<RouletteTiming> = {}) {
    this.ledger = ledger;
    this.clock = clock;
    this.T = { ...PLATFORM.roulette, ...timing };
  }

  /** The rooms waiting for a second player, and the room this player is in. */
  list(playerId: string): { rooms: RouletteRoomInfo[]; mine: string | null } {
    const rooms = [...this.rooms.values()]
      .filter((r) => r.phase === 'waiting')
      .map((r) => ({ id: r.id, host: r.seats[0].name, stake: r.stake, lives: r.lives, createdAt: r.createdAt, mine: r.seats[0].id === playerId }));
    return { rooms, mine: this.roomOf(playerId)?.id ?? null };
  }

  create(p: { id: string; name: string }, input: { stake: unknown; lives: unknown; key: string }): RouletteView {
    if (this.roomOf(p.id)) throw new LedgerError('roulette_busy');
    const lives = input.lives;
    if (typeof lives !== 'number' || !Number.isInteger(lives) || lives < 1 || lives > this.T.maxLives) throw new LedgerError('roulette_lives');
    const stake = input.stake;
    if (typeof stake !== 'number') throw new LedgerError('amount');
    const now = this.clock();
    const session = this.ledger.stake(p.id, stake, input.key);
    const room: Room = {
      id: randomUUID(),
      stake,
      lives,
      createdAt: now,
      seats: [{ id: p.id, name: p.name, session, lives, seen: now }],
      phase: 'waiting',
      until: 0,
      round: 0,
      chambers: [],
      turn: 0,
      next: 'turn',
      winner: null,
      reason: null,
      events: [],
    };
    this.rooms.set(room.id, room);
    return this.view(room, p.id, 0);
  }

  join(p: { id: string; name: string }, roomId: unknown, key: string): RouletteView {
    const room = this.room(roomId);
    if (room.seats.some((s) => s.id === p.id)) return this.view(room, p.id, 0); // the answer was lost: already in
    if (this.roomOf(p.id)) throw new LedgerError('roulette_busy');
    if (room.phase !== 'waiting') throw new LedgerError('roulette_full');
    const now = this.clock();
    const session = this.ledger.stake(p.id, room.stake, key);
    room.seats.push({ id: p.id, name: p.name, session, lives: room.lives, seen: now });
    this.emit(room, { kind: 'start', names: room.seats.map((s) => s.name), lives: room.lives, stake: room.stake });
    this.load(room, now);
    return this.view(room, p.id, 0);
  }

  /** The creator calls the room off before anyone joined: the stake comes back. */
  cancel(playerId: string, roomId: unknown): void {
    const room = this.room(roomId);
    if (room.seats[0].id !== playerId) throw new LedgerError('forbidden');
    if (room.phase !== 'waiting') throw new LedgerError('roulette_full');
    this.end(room, null, 'refund');
  }

  /** The news for a player's game: the state, and the events after `after`. Counts as the player being there. */
  state(playerId: string, roomId: unknown, after: unknown): RouletteView {
    const room = this.room(roomId);
    const seat = room.seats.find((s) => s.id === playerId);
    if (!seat) throw new LedgerError('forbidden');
    seat.seen = this.clock();
    return this.view(room, playerId, typeof after === 'number' ? after : 0);
  }

  /** The player whose turn it is pulls the trigger: at themselves or at the other player. */
  shoot(playerId: string, roomId: unknown, target: unknown): RouletteView {
    const room = this.room(roomId);
    const me = room.seats.findIndex((s) => s.id === playerId);
    if (me < 0) throw new LedgerError('forbidden');
    if (room.phase !== 'turn' || room.turn !== me) throw new LedgerError('roulette_turn');
    if (target !== 'self' && target !== 'other') throw new LedgerError('bad_request');
    room.seats[me].seen = this.clock();
    this.fire(room, target === 'self' ? me : 1 - me, false, this.clock());
    return this.view(room, playerId, 0);
  }

  /** Giving up: the other player wins (before anyone joined it is the same as calling the room off). */
  forfeit(playerId: string, roomId: unknown): void {
    const room = this.room(roomId);
    const me = room.seats.findIndex((s) => s.id === playerId);
    if (me < 0) throw new LedgerError('forbidden');
    if (room.phase === 'over') return;
    if (room.phase === 'waiting') this.end(room, null, 'refund');
    else this.end(room, 1 - me, 'forfeit');
  }

  /** Moves every room on: phases that ran out, players who went away, rooms long finished. */
  tick(): void {
    const now = this.clock();
    for (const room of [...this.rooms.values()]) {
      if (room.phase === 'over') {
        if (now >= room.until) this.rooms.delete(room.id);
        continue;
      }
      // A stake closed some other way (the admin's 강제 종료): the room cannot be paid out any more.
      if (room.seats.some((s) => !this.ledger.open(s.session))) {
        this.end(room, null, 'refund');
        continue;
      }
      const gone = room.seats.findIndex((s) => now - s.seen >= this.T.absentMs);
      if (gone >= 0) {
        if (room.phase === 'waiting') this.end(room, null, 'refund');
        else this.end(room, 1 - gone, 'left');
        continue;
      }
      if (room.phase === 'waiting' || now < room.until) continue;
      if (room.phase === 'load') this.coin(room, now);
      else if (room.phase === 'coin') this.startTurn(room, now);
      else if (room.phase === 'turn') this.fire(room, room.turn, true, now); // time is up: at themselves
      else if (room.phase === 'shot') {
        if (room.next === 'end') this.end(room, room.seats.findIndex((s) => s.lives > 0), 'dead');
        else if (room.next === 'load') this.load(room, now);
        else this.startTurn(room, now);
      }
    }
  }

  /** Every room still open (a server that stops gives their stakes back). */
  closeAll(): void {
    for (const room of this.rooms.values()) if (room.phase !== 'over') this.end(room, null, 'refund');
  }

  // ------------------------------------------------------------ the game

  private load(room: Room, now: number): void {
    room.round++;
    const [lo, hi] = this.T.live;
    const live = lo + randomInt(hi - lo + 1);
    const chambers = Array.from({ length: this.T.chambers }, (_, i) => i < live);
    for (let i = chambers.length - 1; i > 0; i--) {
      const j = randomInt(i + 1);
      [chambers[i], chambers[j]] = [chambers[j], chambers[i]];
    }
    room.chambers = chambers;
    this.emit(room, { kind: 'load', round: room.round, live, blank: chambers.length - live });
    this.phase(room, 'load', now + this.T.loadMs);
  }

  private coin(room: Room, now: number): void {
    room.turn = randomInt(2);
    this.emit(room, { kind: 'coin', first: room.turn });
    this.phase(room, 'coin', now + this.T.coinMs);
  }

  private startTurn(room: Room, now: number): void {
    this.emit(room, { kind: 'turn', seat: room.turn, round: room.round });
    this.phase(room, 'turn', now + this.T.turnMs);
  }

  private fire(room: Room, target: number, auto: boolean, now: number): void {
    const shooter = room.turn;
    const live = room.chambers.shift() ?? false;
    if (live) room.seats[target].lives--;
    const left = { live: room.chambers.filter(Boolean).length, blank: room.chambers.filter((c) => !c).length };
    this.emit(room, { kind: 'shot', shooter, target, live, auto, lives: room.seats.map((s) => s.lives), left });
    if (room.seats.some((s) => s.lives <= 0)) room.next = 'end';
    else if (!room.chambers.length) room.next = 'load';
    else {
      room.next = 'turn';
      if (!(target === shooter && !live)) room.turn = 1 - shooter; // a blank at yourself keeps the turn
    }
    this.phase(room, 'shot', now + this.T.shotMs);
  }

  /** Pays out (the winner takes both stakes; no winner: the stakes go back) and ends the room. */
  private end(room: Room, winner: number | null, reason: DuelReason): void {
    const now = this.clock();
    const pot = room.stake * room.seats.length;
    const open = room.seats.map((s, i) => ({ session: s.session, i })).filter((s) => this.ledger.open(s.session));
    try {
      if (open.length === room.seats.length) {
        this.ledger.settle(reason, open.map(({ session, i }) => ({ session, payout: winner === null ? room.stake : i === winner ? pot : 0 })));
      } else if (open.length) {
        // A stake already gone (the admin's 강제 종료): only a refund adds up, so what is left goes back.
        this.ledger.settle('refund', open.map(({ session }) => ({ session, payout: room.stake })));
      }
    } catch (e) {
      console.error('러시안 룰렛 정산 실패', e); // the sessions stay open for the admin to close
    }
    room.winner = winner;
    room.reason = reason;
    this.emit(room, { kind: 'end', winner, reason, payout: winner === null ? room.stake : pot });
    this.phase(room, 'over', now + this.T.keepMs);
  }

  // ------------------------------------------------------------ plumbing

  private phase(room: Room, phase: Phase, until: number): void {
    room.phase = phase;
    room.until = until;
  }

  private emit(room: Room, e: Unnumbered<RouletteEvent>): void {
    room.events.push({ ...e, n: room.events.length + 1 } as RouletteEvent);
  }

  private room(id: unknown): Room {
    const room = typeof id === 'string' ? this.rooms.get(id) : undefined;
    if (!room) throw new LedgerError('gone');
    return room;
  }

  /** The room this player plays or waits in (a finished one does not count). */
  private roomOf(playerId: string): Room | undefined {
    return [...this.rooms.values()].find((r) => r.phase !== 'over' && r.seats.some((s) => s.id === playerId));
  }

  private view(room: Room, playerId: string, after: number): RouletteView {
    const now = this.clock();
    return {
      id: room.id,
      stake: room.stake,
      lives: room.lives,
      phase: room.phase,
      msLeft: room.phase === 'waiting' || room.phase === 'over' ? 0 : Math.max(0, room.until - now),
      round: room.round,
      turn: room.turn,
      me: room.seats.findIndex((s) => s.id === playerId),
      seats: room.seats.map((s) => ({ name: s.name, lives: s.lives })),
      left: { live: room.chambers.filter(Boolean).length, blank: room.chambers.filter((c) => !c).length },
      winner: room.winner,
      reason: room.reason,
      events: room.events.filter((e) => e.n > after),
      last: room.events.length,
    };
  }
}
