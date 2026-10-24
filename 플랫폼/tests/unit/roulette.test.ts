// 러시안 룰렛 over real HTTP with fast phases: the stakes move only between the two players, turns follow the
// rules, and every way out (a win, giving up, going away, calling the room off, a restart) settles the stakes.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AdminState, RouletteView } from '../../src/shared/protocol.ts';
import { openGame, signup } from '../../src/server/ledger.ts';
import { startServer, type RunningServer } from '../../src/server/server.ts';
import { Store } from '../../src/server/store.ts';

const FAST = { loadMs: 30, coinMs: 30, shotMs: 30, turnMs: 400, absentMs: 1500, keepMs: 2000 };
const running: RunningServer[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of running.splice(0)) await s.close().catch(() => {});
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

type Call = (path: string, body?: unknown, token?: string) => Promise<{ status: number; data: any }>;

async function boot(timing: Partial<typeof FAST> = {}, dir = mkdtempSync(join(tmpdir(), 'roulette-'))) {
  if (!dirs.includes(dir)) dirs.push(dir);
  const srv = await startServer({ dataDir: dir, port: 0, host: '127.0.0.1', timing: { deathStageMinMs: [0, 0, 0, 0, 0], roulette: { ...FAST, ...timing } } });
  running.push(srv);
  const call: Call = async (path, body, token) => {
    const res = await fetch(`${srv.url}api/${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, data: await res.json() };
  };
  /** A player with `chips` chips (the signup bonus, then an admin edit). */
  const player = async (name: string, chips = 5): Promise<{ token: string; id: string }> => {
    const a = (await call('signup', { name, pin: '1234' })).data;
    await call('admin/edit', { id: a.me.id, version: 1, name, pin: '1234', total: chips });
    return { token: a.token, id: a.me.id };
  };
  const totals = async () => {
    const s = (await call('admin/state')).data as AdminState;
    return Object.fromEntries(s.players.map((p) => [p.name, { total: p.total, inGame: p.inGame }]));
  };
  return { srv, dir, call, player, totals };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Polls the room for one player until `done` says so (or the room is over). */
async function until(call: Call, token: string, room: string, done: (v: RouletteView) => boolean, ms = 5000): Promise<RouletteView> {
  const end = Date.now() + ms;
  for (;;) {
    const v = (await call('roulette/state', { room, after: 0 }, token)).data as RouletteView;
    if (done(v)) return v;
    if (Date.now() > end) throw new Error(`timed out in ${v.phase}`);
    await sleep(15);
  }
}

describe('러시안 룰렛', () => {
  it('plays to the end: the survivor takes both stakes, nothing else changes', async () => {
    const { call, player, totals } = await boot();
    const a = await player('철수');
    const b = await player('영희');
    expect((await call('roulette/create', { stake: 3, lives: 6 }, a.token)).data.error).toBe('roulette_lives');
    expect((await call('roulette/create', { stake: 6, lives: 2 }, a.token)).data.error).toBe('funds');
    const made = (await call('roulette/create', { stake: 3, lives: 2, key: 'create-key-1' }, a.token)).data as RouletteView;
    expect(made).toMatchObject({ phase: 'waiting', stake: 3, me: 0 });
    expect(await totals()).toMatchObject({ 철수: { total: 5, inGame: 3 } });
    const list = (await call('roulette/rooms', {}, b.token)).data;
    expect(list.rooms).toMatchObject([{ host: '철수', stake: 3, lives: 2, mine: false }]);
    expect((await call('roulette/join', { room: made.id }, a.token)).data.phase).toBe('waiting'); // already in it
    // A player cannot open or report a 러시안 룰렛 session themselves.
    expect((await call('game/open', { game: 'roulette', stake: 1 }, b.token)).data.error).toBe('game');

    const joined = (await call('roulette/join', { room: made.id, key: 'join-key-1' }, b.token)).data as RouletteView;
    expect(joined.events.map((e) => e.kind)).toEqual(['start', 'load']);
    const load = joined.events[1];
    expect(load.kind === 'load' && load.live + load.blank).toBe(6);
    const tokens = [a.token, b.token];
    let v = await until(call, a.token, made.id, (x) => x.phase === 'turn');
    expect((await call('roulette/shoot', { room: made.id, target: 'other' }, tokens[1 - v.turn])).data.error).toBe('roulette_turn');
    // Both shoot the other one until someone is out of lives.
    while (v.phase !== 'over') {
      if (v.phase === 'turn') await call('roulette/shoot', { room: made.id, target: 'other' }, tokens[v.turn]);
      v = (await call('roulette/state', { room: made.id, after: 0 }, a.token)).data;
      await sleep(10);
    }
    expect(v.reason).toBe('dead');
    const winner = v.winner!;
    const hits = v.events.filter((e) => e.kind === 'shot' && e.live && e.target === 1 - winner);
    expect(hits).toHaveLength(2); // the loser's two lives
    expect(v.seats.map((s) => s.lives)[1 - winner]).toBe(0);
    const t = await totals();
    expect(t[['철수', '영희'][winner]]).toEqual({ total: 8, inGame: 0 });
    expect(t[['철수', '영희'][1 - winner]]).toEqual({ total: 2, inGame: 0 });
  });

  it('a blank at yourself keeps the turn, a live round passes it; an unanswered turn fires at yourself', async () => {
    const { call, player } = await boot({ turnMs: 60 });
    const a = await player('갑');
    const b = await player('을');
    const room = (await call('roulette/create', { stake: 1, lives: 5 }, a.token)).data.id;
    await call('roulette/join', { room }, b.token);
    // Nobody chooses: every turn runs out and the gun goes off at the player whose turn it is.
    const v = await until(call, a.token, room, (x) => x.events.filter((e) => e.kind === 'shot').length >= 8 || x.phase === 'over', 8000);
    const shots = v.events.filter((e): e is Extract<RouletteView['events'][number], { kind: 'shot' }> => e.kind === 'shot');
    for (const s of shots) {
      expect(s.auto).toBe(true);
      expect(s.target).toBe(s.shooter);
    }
    // After a shot the next turn (if the cylinder is not empty) follows the rule.
    const events = v.events;
    for (let i = 0; i < events.length - 1; i++) {
      const e = events[i];
      const next = events.slice(i + 1).find((x) => x.kind === 'turn' || x.kind === 'load');
      if (e.kind !== 'shot' || next?.kind !== 'turn') continue;
      expect(next.seat).toBe(e.live ? 1 - e.shooter : e.shooter);
    }
  });

  it('giving up, going away and calling the room off settle the stakes', async () => {
    const { call, player, totals } = await boot();
    const a = await player('하나');
    const b = await player('둘');
    // Called off before anyone joined: the stake comes back.
    let room = (await call('roulette/create', { stake: 2, lives: 1 }, a.token)).data.id;
    expect((await call('roulette/cancel', { room }, b.token)).data.error).toBe('forbidden');
    await call('roulette/cancel', { room }, a.token);
    expect(await totals()).toMatchObject({ 하나: { total: 5, inGame: 0 } });
    // Giving up mid-game: the other player wins.
    room = (await call('roulette/create', { stake: 2, lives: 3 }, a.token)).data.id;
    await call('roulette/join', { room }, b.token);
    await call('roulette/forfeit', { room }, b.token);
    expect((await call('roulette/state', { room }, a.token)).data).toMatchObject({ phase: 'over', winner: 0, reason: 'forfeit' });
    expect(await totals()).toMatchObject({ 하나: { total: 7 }, 둘: { total: 3 } });
    // Going away (no news asked for absentMs): the other player wins.
    room = (await call('roulette/create', { stake: 1, lives: 5 }, a.token)).data.id;
    await call('roulette/join', { room }, b.token);
    const v = await until(call, a.token, room, (x) => x.phase === 'over', 6000);
    expect(v).toMatchObject({ winner: 0, reason: 'left' });
    expect(await totals()).toMatchObject({ 하나: { total: 8 }, 둘: { total: 2 } });
  });

  it('a server that stops gives the stakes of open rooms back, also after a crash', async () => {
    const { srv, dir, call, player, totals } = await boot();
    const a = await player('셋');
    const b = await player('넷');
    const room = (await call('roulette/create', { stake: 4, lives: 2 }, a.token)).data.id;
    await call('roulette/join', { room }, b.token);
    expect(await totals()).toMatchObject({ 셋: { inGame: 4 }, 넷: { inGame: 4 } });
    await srv.close();
    running.splice(running.indexOf(srv), 1);
    const again = await boot({}, dir);
    expect(await again.totals()).toEqual({ 셋: { total: 5, inGame: 0 }, 넷: { total: 5, inGame: 0 } });
  });

  it('a stake left open by a crash (no refund on the way down) goes back when the server starts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'roulette-'));
    const store = new Store(dir);
    const e = store.run((st) => signup(st, { name: '다섯', pin: '1234', key: 'crash-signup' }));
    if (e.type !== 'signup') throw new Error();
    store.run((st) => openGame(st, { playerId: e.player.id, game: 'roulette', stake: 2, key: 'crash-open', server: true }));
    store.close();
    const { totals } = await boot({}, dir);
    expect(await totals()).toEqual({ 다섯: { total: 2, inGame: 0 } });
  });
});
