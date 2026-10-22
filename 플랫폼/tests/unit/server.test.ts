// The server over real HTTP on a free port, with short timeouts.
import { mkdtempSync, rmSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AdminState, AuthReply, GameOpenReply, LogRecord, MeReply, PlayerView } from '../../src/shared/protocol.ts';
import { startServer, type RunningServer } from '../../src/server/server.ts';

const TIMING = {
  offlineAfterMs: 400,
  sweepMs: 40,
  activitySaveMs: 60_000,
  adminThrottleMs: 10,
  keepAliveMs: 60_000,
  loginLockMs: 300,
  deathStageMinMs: [0, 0, 0, 0, 0], // the 데스 게임 can be "played" at once
};
const running: RunningServer[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const s of running.splice(0)) await s.close().catch(() => {});
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function boot(dir = mkdtempSync(join(tmpdir(), 'srv-')), timing: Partial<typeof TIMING> = {}): Promise<{ srv: RunningServer; dir: string; call: Call }> {
  if (!dirs.includes(dir)) dirs.push(dir);
  const srv = await startServer({ dataDir: dir, port: 0, host: '127.0.0.1', timing: { ...TIMING, ...timing } });
  running.push(srv);
  const call: Call = async (path, body, token) => {
    const res = await fetch(`${srv.url}api/${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, data: await res.json() };
  };
  return { srv, dir, call };
}
type Call = (path: string, body?: unknown, token?: string) => Promise<{ status: number; data: any }>;

/** Plays the 데스 게임 through to its reward (every stage at once: TIMING allows it). */
async function clearDeath(call: Call, token: string): Promise<{ status: number; data: any }> {
  const { run } = (await call('death/start', {}, token)).data as { run: string };
  for (let stage = 1; stage <= 5; stage++) await call('death/stage', { run, stage }, token);
  return call('death/clear', { run, key: `death-${run}` }, token);
}

/** A new player with the 데스 게임's chips to play with. */
async function newPlayer(call: Call, body: { name: string; pin: string; key?: string }): Promise<AuthReply> {
  const auth = (await call('signup', body)).data as AuthReply;
  const done = await clearDeath(call, auth.token);
  return { token: auth.token, me: (done.data as MeReply).me };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function until<T>(f: () => T | undefined | false, ms = 3000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = f();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await sleep(15);
  }
}

/** Reads a server-sent event stream into a list of { event, data }. */
function listen(url: string): { got: { event: string; data: unknown }[]; stop: () => void } {
  const got: { event: string; data: unknown }[] = [];
  const ctl = new AbortController();
  void (async () => {
    try {
      const res = await fetch(url, { signal: ctl.signal });
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const event = /^event: (.*)$/m.exec(block)?.[1];
          const data = /^data: (.*)$/m.exec(block)?.[1];
          if (event && data) got.push({ event, data: JSON.parse(data) });
        }
      }
    } catch {
      // aborted
    }
  })();
  return { got, stop: () => ctl.abort() };
}

describe('server', () => {
  it('signs up, logs in, and locks a name for a while after 5 wrong PINs', async () => {
    const { call } = await boot();
    const s = await call('signup', { name: '철수', pin: '1234', key: 'signup-key-1' });
    expect(s.status).toBe(200);
    const auth = s.data as AuthReply;
    expect(auth.me).toMatchObject({ name: '철수', total: 0, free: 0, held: 0, inGame: 0, deathGame: true, messages: [] });
    expect((await call('me', undefined, auth.token)).data.me.total).toBe(0);
    expect((await call('signup', { name: '철수', pin: '1111' })).data.error).toBe('name_taken');
    for (let i = 0; i < 5; i++) expect((await call('login', { name: '철수', pin: '0000' })).data.error).toBe('login');
    const locked = await call('login', { name: '철수', pin: '1234' });
    expect([locked.status, locked.data.error]).toEqual([429, 'locked']);
    await sleep(350);
    const ok = await call('login', { name: '철수', pin: '1234' });
    expect(ok.status).toBe(200);
    // The new login ends the old one.
    expect((await call('me', undefined, auth.token)).data.error).toBe('session');
    expect((await call('me', undefined, ok.data.token)).status).toBe(200);
  });

  it('refuses bad JSON and unknown routes cleanly', async () => {
    const { srv } = await boot();
    const res = await fetch(`${srv.url}api/signup`, { method: 'POST', body: '{nope' });
    expect([res.status, (await res.json()).error]).toEqual([400, 'bad_request']);
    expect((await fetch(`${srv.url}api/nothing`)).status).toBe(404);
  });

  it('holds a settlement request until the admin pays it; a resent request counts once', async () => {
    const { call } = await boot();
    const { token } = await newPlayer(call, { name: '영희', pin: '1234' });
    const body = { amount: 3, key: 'settle-key-1' };
    await call('settle', body, token);
    const again = (await call('settle', body, token)).data as MeReply;
    expect(again.me).toMatchObject({ total: 5, free: 2, held: 3 });
    const state = (await call('admin/state')).data as AdminState;
    expect(state.settlements).toHaveLength(1);
    await call('admin/settle/done', { id: state.settlements[0].id });
    expect((await call('me', undefined, token)).data.me).toMatchObject({ total: 2, held: 0 });
    // Paying twice is refused.
    expect((await call('admin/settle/done', { id: state.settlements[0].id })).data.error).toBe('gone');
  });

  it('a game reports its result with the session secret, even after the player logged out', async () => {
    const { call } = await boot();
    const { token } = await newPlayer(call, { name: '게임', pin: '1234' });
    const open = (await call('game/open', { game: 'yabawi', stake: 5, key: 'open-key-1' }, token)).data as GameOpenReply;
    expect(open.me).toMatchObject({ total: 5, free: 0, inGame: 5 });
    await call('logout', {}, token);
    const close = await call('game/close', { id: open.session.id, secret: open.session.secret, payout: 0 });
    expect(close.status).toBe(200);
    const state = (await call('admin/state')).data as AdminState & { log: LogRecord[] };
    // Lost everything: recorded as a bankruptcy, and the 데스 게임 is open again.
    expect(state.log.map((r) => r.kind)).toEqual(['signup', 'deathClear', 'gameOpen', 'gameClose', 'bankrupt']);
    expect(state.players[0]).toMatchObject({ total: 0, deathClears: 1 });
  });

  it('pushes changes to the player app and tells an old login it was replaced', async () => {
    const { srv, call } = await boot();
    const { token, me } = await newPlayer(call, { name: '실시간', pin: '1234' });
    const stream = listen(`${srv.url}api/events?token=${token}`);
    await until(() => stream.got.find((g) => g.event === 'me'));
    const p = ((await call('admin/state')).data as AdminState).players[0];
    await call('admin/edit', { id: me.id, version: p.version, name: '실시간', pin: '1234', total: 20 });
    await until(() => stream.got.find((g) => g.event === 'me' && (g.data as PlayerView).total === 20));
    // A stale edit (the version it saw is gone) is refused.
    expect((await call('admin/edit', { id: me.id, version: p.version, name: 'x', pin: '1234', total: 1 })).data.error).toBe('conflict');
    await call('login', { name: '실시간', pin: '1234' });
    await until(() => stream.got.find((g) => g.event === 'kicked'));
    stream.stop();
  });

  it('shows who is online by their reports, and saves the time they were online', async () => {
    const { call } = await boot();
    const { token, me } = (await call('signup', { name: '접속', pin: '1234' })).data as AuthReply;
    const online = async () => ((await call('admin/state')).data as AdminState).players.find((x) => x.id === me.id)!;
    expect((await online()).online).toBe(true);
    await sleep(150);
    await call('ping', {}, token);
    await sleep(150);
    await call('ping', {}, token);
    const before = await online();
    expect(before.activeMs).toBeGreaterThanOrEqual(250);
    // No more reports: offline after offlineAfterMs, with the online time kept.
    await sleep(600);
    const after = await online();
    expect(after.online).toBe(false);
    expect(after.activeMs).toBeGreaterThanOrEqual(250);
  });

  it('comes back after a restart with the same ledger and the same logins', async () => {
    const { srv, dir, call } = await boot();
    const { token } = await newPlayer(call, { name: '재시작', pin: '1234' });
    await call('settle', { amount: 2 }, token);
    await srv.close();
    running.splice(running.indexOf(srv), 1);
    const second = await boot(dir);
    expect((await second.call('me', undefined, token)).data.me).toMatchObject({ name: '재시작', total: 5, held: 2 });
  });

  it('exports the DB 기록 as a CSV Excel can read', async () => {
    const { srv, call } = await boot();
    await newPlayer(call, { name: '기록', pin: '1234' });
    const res = await fetch(`${srv.url}api/admin/log.csv`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]); // BOM
    const text = new TextDecoder().decode(bytes);
    expect(text).toContain('"번호","시각","종류","플레이어"');
    expect(text).toContain('"가입","기록","0","0"');
    expect(text).toContain('"데스 게임 통과","기록","5","5"');
  });

  it('pays the 데스 게임 for a whole run only: in order, no faster than a person, to a player with no chips', async () => {
    const { call } = await boot();
    const { token } = (await call('signup', { name: '도전자', pin: '1234' })).data as AuthReply;
    expect((await call('death/clear', { run: 'x', key: 'death-x' }, token)).data.error).toBe('death_run');
    // Out of order: the run is void.
    let { run } = (await call('death/start', {}, token)).data;
    expect((await call('death/stage', { run, stage: 2 }, token)).data.error).toBe('death_run');
    expect((await call('death/stage', { run, stage: 1 }, token)).data.error).toBe('death_run');
    // Stopped early: no reward.
    ({ run } = (await call('death/start', {}, token)).data);
    for (let stage = 1; stage <= 4; stage++) expect((await call('death/stage', { run, stage }, token)).status).toBe(200);
    expect((await call('death/stage', { run, stage: 4 }, token)).status).toBe(200); // sent again: harmless
    expect((await call('death/clear', { run, key: 'death-early' }, token)).data.error).toBe('death_run');
    expect((await call('death/stage', { run, stage: 5 }, token)).status).toBe(200);
    const done = await call('death/clear', { run, key: 'death-key-1' }, token);
    expect(done.data.me).toMatchObject({ total: 5, deathGame: false });
    // The answer was lost: the same key gets the same result, not a second reward.
    expect((await call('death/clear', { run, key: 'death-key-1' }, token)).data.me.total).toBe(5);
    expect((await call('death/start', {}, token)).data.error).toBe('death_rich');

    // A stage reported sooner than anyone can play it: refused.
    const slow = await boot(undefined, { deathStageMinMs: [60_000, 0, 0, 0, 0] });
    const other = (await slow.call('signup', { name: '번개', pin: '1234' })).data as AuthReply;
    const r = (await slow.call('death/start', {}, other.token)).data.run;
    expect((await slow.call('death/stage', { run: r, stage: 1 }, other.token)).data.error).toBe('death_run');
  });

  it('carries a player\'s message to the admin, and back that it was read; at most a few a minute', async () => {
    const { call } = await boot();
    const { token } = (await call('signup', { name: '문의', pin: '1234' })).data as AuthReply;
    const sent = await call('message', { text: '칩이 안 들어왔어요', key: 'msg-key-1' }, token);
    expect(sent.data.me.messages).toMatchObject([{ text: '칩이 안 들어왔어요', read: false }]);
    expect((await call('message', { text: '칩이 안 들어왔어요', key: 'msg-key-1' }, token)).data.me.messages).toHaveLength(1);
    const state = (await call('admin/state')).data as AdminState;
    expect(state.messages).toMatchObject([{ name: '문의', text: '칩이 안 들어왔어요', read: false }]);
    await call('admin/message/read', { id: state.messages[0].id });
    expect((await call('me', undefined, token)).data.me.messages[0].read).toBe(true);
    expect((await call('message', { text: '' }, token)).data.error).toBe('message');
    for (let i = 0; i < 3; i++) await call('message', { text: `${i}` }, token);
    expect((await call('message', { text: '또' }, token)).data.error).toBe('busy');
  });
});

describe('admin guard', () => {
  it('lets in the admin PC itself only', async () => {
    const { fromThisPcForTest } = await import('../../src/server/server.ts');
    const req = (remoteAddress: string, localAddress: string) => ({ socket: { remoteAddress, localAddress } }) as unknown as IncomingMessage;
    expect(fromThisPcForTest(req('127.0.0.1', '127.0.0.1'))).toBe(true);
    expect(fromThisPcForTest(req('::1', '::1'))).toBe(true);
    expect(fromThisPcForTest(req('::ffff:192.168.0.12', '::ffff:192.168.0.12'))).toBe(true); // its own Wi-Fi address
    expect(fromThisPcForTest(req('::ffff:192.168.0.31', '::ffff:192.168.0.12'))).toBe(false); // a player PC
  });
});
