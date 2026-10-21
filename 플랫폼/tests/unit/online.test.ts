// 온라인판: the public listener cloudflared talks to. Everything that arrives there came from the
// internet, so it must never reach the admin side, and signups, logins and big wins are held to tighter rules.
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PLATFORM } from '../../src/shared/config.ts';
import type { AdminState } from '../../src/shared/protocol.ts';
import { ipKey, startServer, type RunningServer } from '../../src/server/server.ts';

const running: RunningServer[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of running.splice(0)) await s.close().catch(() => {});
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

type Reply = { status: number; data: any; headers?: Headers };
async function boot(dir = mkdtempSync(join(tmpdir(), 'online-')), timing: { entryLockMs?: number } = {}) {
  if (!dirs.includes(dir)) dirs.push(dir);
  const srv = await startServer({ dataDir: dir, port: 0, host: '127.0.0.1', publicPort: 0, discoveryPort: null, timing });
  running.push(srv);
  const at = (port: number) => async (path: string, body?: unknown, o: { token?: string; ip?: string } = {}): Promise<Reply> => {
    const res = await fetch(`http://127.0.0.1:${port}/${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(o.token ? { Authorization: `Bearer ${o.token}` } : {}),
        ...(o.ip ? { 'CF-Connecting-IP': o.ip } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let data: unknown = text;
    try {
      data = JSON.parse(text);
    } catch {
      // a page, not JSON
    }
    return { status: res.status, data, headers: res.headers };
  };
  const lan = at(srv.port);
  const pub = at(srv.publicPort!);
  const code = async (): Promise<string> => ((await lan('api/admin/state')).data as AdminState).server.online!.code;
  return { srv, dir, lan, pub, code };
}

describe('public listener', () => {
  it('never reaches the admin side, though cloudflared connects from 127.0.0.1', async () => {
    const { lan, pub } = await boot();
    for (const path of ['admin', 'admin.html', 'api/admin/state', 'api/admin/log.csv', 'api/admin/events', 'api/events?token=x']) {
      expect((await pub(path)).status, path).toBe(404);
    }
    for (const path of ['api/admin/edit', 'api/admin/review', 'api/admin/online/code', 'api/admin/settle']) {
      expect((await pub(path, {})).status, path).toBe(404);
    }
    // The same requests on the Wi-Fi listener from this PC are the admin's.
    expect((await lan('api/admin/state')).status).toBe(200);
  });

  it('says how it works: online through the tunnel, as before on the Wi-Fi', async () => {
    const { lan, pub } = await boot();
    expect((await pub('api/hello')).data).toEqual({ online: true, pingMs: PLATFORM.online.pingMs, entryDigits: PLATFORM.online.entryDigits });
    expect((await lan('api/hello')).data).toEqual({ online: false, pingMs: PLATFORM.pingMs, entryDigits: 0 });
  });

  it('asks the 입장 코드 for signup and login through the tunnel only; the admin can change it', async () => {
    const { lan, pub, code, dir } = await boot();
    const c = await code();
    expect(c).toMatch(new RegExp(`^\\d{${PLATFORM.online.entryDigits}}$`));
    expect(PLATFORM.online.entryDigits).toBeGreaterThanOrEqual(6);
    expect((await pub('api/signup', { name: '외부인', pin: '1111' })).data.error).toBe('entry');
    expect((await pub('api/signup', { name: '외부인', pin: '1111', code: '' })).status).toBe(403);
    expect((await pub('api/signup', { name: '손님', pin: '1111', code: c })).status).toBe(200);
    expect((await pub('api/login', { name: '손님', pin: '1111' })).data.error).toBe('entry');
    expect((await pub('api/login', { name: '손님', pin: '1111', code: c })).status).toBe(200);
    expect((await lan('api/signup', { name: '부스', pin: '2222' })).status).toBe(200); // Wi-Fi: no code, as before
    const next = (await lan('api/admin/online/code', {})).data.code as string;
    expect(next).toMatch(new RegExp(`^\\d{${PLATFORM.online.entryDigits}}$`));
    if (next !== c) expect((await pub('api/login', { name: '손님', pin: '1111', code: c })).data.error).toBe('entry');
    expect((await pub('api/login', { name: '손님', pin: '1111', code: next })).status).toBe(200);
    // A restart brings a new code (with a new internet address); nothing is written next to the ledger.
    await running.pop()!.close();
    const again = await boot(dir);
    expect(await again.code()).not.toBe(next); // one in a million to collide
    expect(readdirSync(dir)).not.toContain('online.json');
  });

  it('shuts out an IP that gets the 입장 코드 wrong too often, even with the right code after', async () => {
    const { pub, code } = await boot(undefined, { entryLockMs: 300 });
    const c = await code();
    const ip = { ip: '198.51.100.9' };
    for (let i = 0; i < PLATFORM.online.entryFails; i++) {
      expect((await pub('api/login', { name: '누구', pin: '0000', code: '000000' }, ip)).data.error).toBe('entry');
    }
    const locked = await pub('api/signup', { name: '들어가기', pin: '1111', code: c }, ip);
    expect(locked.status).toBe(429);
    expect(locked.data.error).toBe('entry_locked');
    expect((await pub('api/signup', { name: '다른 사람', pin: '1111', code: c }, { ip: '198.51.100.10' })).status).toBe(200);
    await new Promise((r) => setTimeout(r, 350));
    expect((await pub('api/signup', { name: '들어가기', pin: '1111', code: c }, ip)).status).toBe(200);
  });

  it('counts an IPv6 /64 as one place, so new addresses in it do not bring new tries', async () => {
    expect(ipKey('203.0.113.5')).toBe('203.0.113.5');
    expect(ipKey('::ffff:203.0.113.5')).toBe('203.0.113.5');
    expect(ipKey('2001:db8:0:1::7')).toBe('2001:db8:0:1::/64');
    expect(ipKey('2001:0db8:0000:0001:aaaa:bbbb:cccc:dddd')).toBe('2001:db8:0:1::/64');
    expect(ipKey('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(ipKey('')).toBe('unknown');
    const { pub, code } = await boot(undefined, { entryLockMs: 60_000 });
    const c = await code();
    for (let i = 0; i < PLATFORM.online.entryFails; i++) {
      await pub('api/login', { name: '누구', pin: '0000', code: '000000' }, { ip: `2001:db8:0:1::${i + 1}` });
    }
    expect((await pub('api/signup', { name: '새주소', pin: '1111', code: c }, { ip: '2001:db8:0:1:ffff::99' })).data.error).toBe('entry_locked');
    expect((await pub('api/signup', { name: '옆집', pin: '1111', code: c }, { ip: '2001:db8:0:2::1' })).status).toBe(200);
  });

  it('stops checking codes for a while once too many wrong ones come from everywhere', async () => {
    const { pub, code } = await boot();
    const c = await code();
    for (let i = 0; i < PLATFORM.online.wrongPerMin; i++) {
      const r = await pub('api/login', { name: '누구', pin: '0000', code: '000000' }, { ip: `192.0.2.${i % 250}` });
      expect(r.data.error).toBe('entry');
    }
    // Even the right code is not checked now (otherwise the guessing would go on), from a place that never guessed.
    expect((await pub('api/signup', { name: '정상', pin: '1111', code: c }, { ip: '198.51.100.200' })).data.error).toBe('busy');
  });

  it('a signup with a wrong code does not use up the signup budget', async () => {
    const { pub, code } = await boot();
    const c = await code();
    for (let i = 0; i < PLATFORM.online.signupsPerMin; i++) {
      await pub('api/signup', { name: `가짜${i}`, pin: '1111', code: '000000' }, { ip: `192.0.2.${i}` });
    }
    expect((await pub('api/signup', { name: '진짜', pin: '1111', code: c }, { ip: '198.51.100.1' })).status).toBe(200);
  });

  it('a request line that is not a URL gets a 400 and the server keeps running', async () => {
    const { srv, pub } = await boot();
    const { request } = await import('node:http');
    const status = await new Promise<number>((done, fail) => {
      const r = request({ host: '127.0.0.1', port: srv.publicPort!, path: 'http://[', method: 'GET' }, (res) => {
        res.resume();
        done(res.statusCode ?? 0);
      });
      r.on('error', fail);
      r.end();
    });
    expect(status).toBe(400);
    expect((await pub('api/hello')).status).toBe(200);
  });

  it('answers through the tunnel without CORS and with safety headers; the Wi-Fi side as before', async () => {
    const { lan, pub } = await boot();
    const p = await pub('api/hello');
    expect(p.headers?.get('access-control-allow-origin')).toBeNull();
    expect(p.headers?.get('x-content-type-options')).toBe('nosniff');
    expect(p.headers?.get('x-frame-options')).toBe('SAMEORIGIN');
    expect((await pub('api/nothing')).headers?.get('access-control-allow-origin')).toBeNull();
    expect((await lan('api/hello')).headers?.get('access-control-allow-origin')).toBe('*');
  });

  it('limits signup and login tries per IP through the tunnel', async () => {
    const { pub, code } = await boot();
    const c = await code();
    let last: Reply = { status: 0, data: null };
    for (let i = 0; i <= PLATFORM.online.ratePerIp; i++) last = await pub('api/login', { name: '없음', pin: '0000', code: c }, { ip: '203.0.113.7' });
    expect(last.data.error).toBe('busy');
    expect(last.status).toBe(429);
    // Another IP is not held up (another name: the old per-name PIN lock has locked this one by now).
    expect((await pub('api/login', { name: '다른 이름', pin: '0000', code: c }, { ip: '203.0.113.8' })).data.error).toBe('login');
  });

  it('holds a big online win until the admin approves it; the same game on the Wi-Fi pays at once', async () => {
    const { lan, pub, code } = await boot();
    const c = await code();
    const auth = (await pub('api/signup', { name: '행운', pin: '7777', code: c })).data;
    const big = 1 + PLATFORM.online.reviewNet;
    const play = async (call: typeof pub) => {
      const r = await call('api/game/open', { game: 'yabawi', stake: 1, key: `k-${Math.random()}` }, { token: auth.token });
      expect(r.status).toBe(200);
      return r.data.session as { id: string; secret: string };
    };
    const online = await play(pub);
    const held = await pub('api/game/close', { id: online.id, secret: online.secret, payout: big });
    expect(held.data.review).toBe(true);
    expect(held.data.me.total).toBe(5); // nothing paid yet: the stake is still in the game
    expect(held.data.me.games[0].review).toBe(big);
    const state = (await lan('api/admin/state')).data as AdminState;
    expect(state.games.find((g) => g.id === online.id)).toMatchObject({ online: true, review: big });
    expect((await lan('api/admin/review', { id: online.id, approve: true })).status).toBe(200);
    expect((await pub('api/me', undefined, { token: auth.token })).data.me.total).toBe(5 + big - 1);
    // Opened on the Wi-Fi: paid as before.
    const wifi = await play(lan);
    const paid = await lan('api/game/close', { id: wifi.id, secret: wifi.secret, payout: big });
    expect(paid.data.review).toBe(false);
    expect(paid.data.me.total).toBe(5 + 2 * (big - 1));
  });
});
