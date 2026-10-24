// The ledger server on the admin PC. Plain node:http, no packages: JSON requests, and server-sent events for live
// updates to the admin screen (and to a player app opened on this PC). The main listener answers on 127.0.0.1 only:
// the admin page, the admin API, and the player routes for testing on the admin PC itself. Players play through the
// internet address only (no direct Wi-Fi connections).
//
// Online means the player app reported in within PLATFORM.offlineAfterMs (it does every PLATFORM.pingMs). A
// connection alone proves nothing: a laptop that loses its network leaves its connection open for minutes.
//
// With `publicPort` a second listener on 127.0.0.1 is the way in for cloudflared. Everything
// that arrives there came from the internet, whatever its address says (cloudflared connects from 127.0.0.1), so it
// gets the player routes only: no admin page, no admin API, no live updates (a Quick Tunnel does not pass them).
// Signup and login there need the 입장 코드 (a new one at every start: the internet address changes then too), are
// rate-limited per IP, and an IP that gets the code wrong too often is shut out for a while. Big wins wait for the
// admin. Answers there carry no CORS header (the player app is served from the same address) and a few safety
// headers.
//
// 데스 게임: the page plays in the browser, so the server follows each run (in memory: a restart means starting
// over). A run starts only for a player with no chips at all, its five stages must be reported in
// order and no faster than stageMinMs, and only then does the ledger pay the reward.
//
// 러시안 룰렛: the rooms and games run here too (roulette.ts); the players' games poll /api/roulette/state.
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, resolve, sep } from 'node:path';
import { randomInt, randomUUID } from 'node:crypto';
import { PLATFORM, gameDef } from '../shared/config.ts';
import { ERROR_TEXT, LOG_LABEL, type AdminOnline, type AdminState, type ErrorCode, type Hello } from '../shared/protocol.ts';
import {
  LedgerError,
  activity,
  cancelSettlement,
  cleanName,
  closeGame,
  clearDeathGame,
  completeSettlement,
  deathOpenFor,
  decideReview,
  directSettlement,
  edit,
  endDuel,
  login,
  logout,
  nameKey,
  openGame,
  readMessage,
  remove,
  requestSettlement,
  sendMessage,
  signup,
  type LedgerEvent,
  type Player,
} from './ledger.ts';
import { RouletteHall, type RouletteTiming } from './roulette.ts';
import { Store } from './store.ts';
import { startTunnel, type Tunnel, type TunnelState } from './tunnel.ts';
import { adminState, playerRankView, playerView, rankView, type Live } from './views.ts';

export interface ServerOptions {
  dataDir: string;
  port?: number; // 0: any free port (tests)
  host?: string; // default 127.0.0.1: nothing on the network reaches the main listener
  staticDir?: string; // the built pages and games; without it only the API answers
  publicPort?: number | null; // the player-only listener for cloudflared, on 127.0.0.1 (0: any free port; null: none)
  tunnel?: { exe: string } | null; // run this cloudflared to the public port
  clock?: () => number;
  timing?: Partial<Timing>;
}

interface Timing {
  offlineAfterMs: number;
  activitySaveMs: number;
  sweepMs: number; // how often presence is checked
  keepAliveMs: number; // comment lines on idle event streams
  adminThrottleMs: number; // admin screen updates at most this often
  loginLockMs: number;
  entryLockMs: number; // an IP that got the 입장 코드 wrong too often waits this long
  deathStageMinMs: readonly number[]; // 데스 게임: the least time a stage can take (tests: 0)
  roulette: Partial<RouletteTiming>; // 러시안 룰렛's phases (tests: shorter)
}

/** A 데스 게임 run the server follows: the stages cleared so far and when the last one was. */
interface DeathRun {
  id: string;
  stage: number;
  at: number;
}

export interface RunningServer {
  port: number;
  publicPort: number | null;
  tunnel(): TunnelState | null;
  url: string; // on this PC
  store: Store;
  close(): Promise<void>;
}

interface Segment {
  since: number; // online since (or since the activity was last saved)
  last: number; // last report
}

interface Stream {
  res: ServerResponse;
  login: string; // the login it was opened with
}

interface AdminStream {
  res: ServerResponse;
  logSent: number; // log lines already sent
}

const STATUS: Partial<Record<ErrorCode, number>> = {
  session: 401,
  forbidden: 403,
  not_found: 404,
  gone: 404,
  conflict: 409,
  name_taken: 409,
  pending: 409,
  closed: 409,
  review: 409,
  entry: 403,
  entry_locked: 429,
  locked: 429,
  busy: 429,
};

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
};

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function startServer(o: ServerOptions): Promise<RunningServer> {
  const clock = o.clock ?? Date.now;
  const T: Timing = {
    offlineAfterMs: PLATFORM.offlineAfterMs,
    activitySaveMs: PLATFORM.activitySaveMs,
    sweepMs: 1000,
    keepAliveMs: 15_000,
    adminThrottleMs: 150,
    loginLockMs: PLATFORM.loginLockMs,
    entryLockMs: PLATFORM.online.entryLockMs,
    deathStageMinMs: PLATFORM.deathGame.stageMinMs,
    roulette: {},
    ...o.timing,
  };
  const store = new Store(o.dataDir, clock);
  const dataDir = resolve(o.dataDir);
  const startedAt = clock();
  const presence = new Map<string, Segment>();
  const fails = new Map<string, { count: number; until: number }>();
  const playerStreams = new Map<string, Set<Stream>>();
  const adminStreams = new Set<AdminStream>();
  let adminTimer: NodeJS.Timeout | null = null;
  let closing = false;

  // 온라인판: the 입장 코드 lives only in memory (a restart gives a new one with the new address), the tunnel is cloudflared.
  const online = o.publicPort != null;
  let entryCode = online ? newCode() : '';
  let tunnel: Tunnel | null = null;
  const triesByIp = new Map<string, number[]>(); // signup and login times per IP, through the tunnel
  const wrongCodes = new Map<string, { count: number; until: number }>(); // wrong 입장 코드 per IP
  const wrongTimes: number[] = []; // wrong 입장 코드 from everywhere, last minute
  const signupTimes: number[] = [];
  const deathRuns = new Map<string, DeathRun>(); // player id → the 데스 게임 run in progress

  // 러시안 룰렛: stakes left in the ledger by a server that stopped (its rooms are gone) go back first.
  for (const g of [...store.state.games.values()]) {
    if (gameDef(g.game)?.duel) store.run((s) => endDuel(s, { reason: 'refund', closes: [{ id: g.id, payout: g.stake }] }));
  }
  const hall = new RouletteHall(
    {
      stake: (playerId, stake, key) => {
        const e = store.run((s) => openGame(s, { playerId, game: 'roulette', stake, key, server: true }));
        if (e.type !== 'gameOpen') throw new LedgerError('bad_request');
        return e.session.id;
      },
      settle: (reason, closes) => {
        store.run((s) => endDuel(s, { reason, closes: closes.map((c) => ({ id: c.session, payout: c.payout })) }));
      },
      open: (session) => store.state.games.has(session),
    },
    clock,
    T.roulette,
  );
  const hallTimer = setInterval(() => hall.tick(), 200);
  const messageTimes = new Map<string, number[]>(); // player id → messages sent in the last minute

  // ------------------------------------------------------------ presence

  const live = (id: string): Live | null => {
    const seg = presence.get(id);
    const p = store.state.players.get(id);
    if (!seg || !p) return null;
    return { online: true, lastActiveAt: seg.last, activeMs: p.activeMs + seg.last - seg.since };
  };

  /** Saves the online time of a segment to the ledger. */
  function saveActivity(id: string, seg: Segment): void {
    const p = store.state.players.get(id);
    if (!p || seg.last <= seg.since) return;
    store.run((s) => activity(s, { id, lastActiveAt: seg.last, activeMs: p.activeMs + seg.last - seg.since }));
    seg.since = seg.last;
  }

  /** The player app reported in. */
  function touch(id: string): void {
    const now = clock();
    const seg = presence.get(id);
    if (seg && now - seg.last < T.offlineAfterMs) {
      seg.last = now;
      return;
    }
    if (seg) saveActivity(id, seg);
    presence.set(id, { since: now, last: now });
    scheduleAdmin();
  }

  function goOffline(id: string): void {
    const seg = presence.get(id);
    if (!seg) return;
    saveActivity(id, seg);
    presence.delete(id);
    scheduleAdmin();
  }

  const sweep = setInterval(() => {
    const now = clock();
    for (const [id, seg] of presence) {
      if (now - seg.last >= T.offlineAfterMs) goOffline(id);
      else if (seg.last - seg.since >= T.activitySaveMs) saveActivity(id, seg);
    }
  }, T.sweepMs);

  // ------------------------------------------------------------ pushes

  function sse(res: ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write('retry: 2000\n\n');
  }
  const send = (res: ServerResponse, event: string, data: unknown): void => {
    if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  function pushMe(id: string): void {
    const me = playerView(store.state, id);
    for (const st of playerStreams.get(id) ?? []) if (me) send(st.res, 'me', me);
  }

  function kick(id: string, reason: string, keep?: string): void {
    for (const st of playerStreams.get(id) ?? []) {
      if (keep && st.login === keep) continue;
      send(st.res, 'kicked', { reason });
      st.res.end();
    }
  }

  const onlineInfo = (): AdminOnline | null =>
    online
      ? {
          ...(tunnel?.state() ?? { status: 'stopped', url: null, message: '터널 없이 공개 포트만 열려 있습니다' }),
          code: entryCode,
        }
      : null;
  const adminInfo = (): AdminState => adminState(store.state, live, clock(), { dataDir, startedAt, online: onlineInfo() });

  /** Drops what is older than a minute; returns how many are left. */
  function lastMinute(times: number[]): number {
    const now = clock();
    while (times.length && now - times[0] >= 60_000) times.shift();
    return times.length;
  }

  /** At most `max` in the last minute, or 'busy'. */
  function limit(times: number[], max: number): void {
    if (lastMinute(times) >= max) throw new LedgerError('busy');
    times.push(clock());
  }

  /** The 입장 코드 through the tunnel: rate-limited per IP, wrong codes counted per IP and for everyone together. */
  function checkEntry(req: IncomingMessage, b: Body): void {
    // cloudflared puts the visitor's address here; only the public listener ever reads it (it can be faked elsewhere).
    // An IPv6 visitor holds a whole /64, so that is what counts as one place.
    const ip = ipKey(String(req.headers['cf-connecting-ip'] ?? '').split(',')[0].trim());
    const now = clock();
    const wrong = wrongCodes.get(ip);
    if (wrong && wrong.until > now) throw new LedgerError('entry_locked');
    let times = triesByIp.get(ip);
    if (!times) triesByIp.set(ip, (times = []));
    limit(times, PLATFORM.online.ratePerIp);
    // Someone is guessing from many places at once: check no code at all until the minute calms down.
    if (lastMinute(wrongTimes) >= PLATFORM.online.wrongPerMin) throw new LedgerError('busy');
    if (String(b.code ?? '') !== entryCode) {
      wrongTimes.push(now);
      const count = (wrong && wrong.until === 0 ? wrong.count : 0) + 1;
      wrongCodes.set(ip, count >= PLATFORM.online.entryFails ? { count: 0, until: now + T.entryLockMs } : { count, until: 0 });
      throw new LedgerError('entry');
    }
    wrongCodes.delete(ip);
  }

  /** The player's 데스 게임 run, if `run` names it. */
  function deathRun(p: Player, run: unknown): DeathRun {
    const r = deathRuns.get(p.id);
    if (!r || r.id !== run) throw new LedgerError('death_run');
    return r;
  }

  /** Signup and login through the tunnel: only with the 입장 코드. */
  function gate(req: IncomingMessage, b: Body, signingUp: boolean): void {
    checkEntry(req, b);
    if (signingUp) limit(signupTimes, PLATFORM.online.signupsPerMin); // only signups that had the code count
  }

  function scheduleAdmin(): void {
    if (closing || adminTimer || adminStreams.size === 0) return;
    adminTimer = setTimeout(() => {
      adminTimer = null;
      const state = adminInfo();
      const log = store.state.log;
      for (const a of adminStreams) {
        send(a.res, 'update', { ...state, log: log.slice(a.logSent) });
        a.logSent = log.length;
      }
    }, T.adminThrottleMs);
  }

  const keepAlive = setInterval(() => {
    for (const set of playerStreams.values()) for (const st of set) if (!st.res.writableEnded) st.res.write(': ping\n\n');
    for (const a of adminStreams) if (!a.res.writableEnded) a.res.write(': ping\n\n');
  }, T.keepAliveMs);

  store.onEvent((e: LedgerEvent) => {
    switch (e.type) {
      case 'activity':
        return; // saved online time: nothing new to show
      case 'login':
        kick(e.id, '다른 PC에서 같은 계정으로 로그인했습니다', e.login);
        break;
      case 'logout':
        kick(e.id, '로그아웃했습니다');
        break;
      case 'delete':
        kick(e.id, '관리자가 계정을 삭제했습니다');
        presence.delete(e.id);
        break;
    }
    const id = affected(e);
    if (id) pushMe(id);
    scheduleAdmin();
  });

  // ------------------------------------------------------------ requests

  function authPlayer(token: unknown): Player {
    const [id, secret] = typeof token === 'string' ? token.split('.') : [];
    const p = id ? store.state.players.get(id) : undefined;
    if (!p || !p.login || p.login !== secret) throw new LedgerError('session');
    return p;
  }
  const bearer = (req: IncomingMessage): string => (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  const tokenOf = (p: Player): string => `${p.id}.${p.login}`;
  const keyOf = (b: Record<string, unknown>): string =>
    typeof b.key === 'string' && b.key.length >= 8 && b.key.length <= 80 ? b.key : randomUUID();
  const me = (id: string) => playerView(store.state, id);

  type Body = Record<string, unknown>;
  type Handler = (req: IncomingMessage, body: Body, res: ServerResponse, pub: boolean) => unknown;

  const playerRoutes: Record<string, Handler> = {
    'GET /api/hello': (_req, _b, _res, pub): Hello => ({
      online: pub,
      pingMs: pub ? PLATFORM.online.pingMs : PLATFORM.pingMs,
      entryDigits: pub ? PLATFORM.online.entryDigits : 0,
    }),
    // The player exe checks the 입장 코드 once, together with the internet address, and hands it to the app.
    'POST /api/entry': (req, b, _res, pub) => {
      if (pub) checkEntry(req, b);
      return { ok: true };
    },
    'POST /api/signup': (req, b, _res, pub) => {
      if (pub) gate(req, b, true);
      const e = store.run((s) => signup(s, { name: b.name, pin: b.pin, key: keyOf(b) }));
      if (e.type !== 'signup') throw new LedgerError('bad_request');
      const p = store.state.players.get(e.player.id);
      if (!p || p.login !== e.player.login) throw new LedgerError('session'); // replayed after a newer login
      touch(p.id);
      return { token: tokenOf(p), me: me(p.id) };
    },
    'POST /api/login': (req, b, _res, pub) => {
      if (pub) gate(req, b, false);
      const k = nameKey(cleanName(b.name));
      const now = clock();
      const f = fails.get(k);
      if (f && f.until > now) throw new LedgerError('locked');
      let e: LedgerEvent;
      try {
        e = store.run((s) => login(s, { name: b.name, pin: b.pin, key: keyOf(b) }));
      } catch (err) {
        if (err instanceof LedgerError && err.code === 'login') {
          const count = (f && f.until <= now && f.until > 0 ? 0 : (f?.count ?? 0)) + 1;
          fails.set(k, count >= PLATFORM.loginFails ? { count: 0, until: now + T.loginLockMs } : { count, until: 0 });
        }
        throw err;
      }
      fails.delete(k);
      if (e.type !== 'login') throw new LedgerError('bad_request');
      const p = store.state.players.get(e.id);
      if (!p || p.login !== e.login) throw new LedgerError('session'); // an old login replayed after a newer one
      touch(p.id);
      return { token: tokenOf(p), me: me(p.id) };
    },
    'POST /api/logout': (req) => {
      const p = authPlayer(bearer(req));
      goOffline(p.id);
      store.run((s) => logout(s, p.id));
      return { ok: true };
    },
    'GET /api/me': (req) => {
      const p = authPlayer(bearer(req));
      touch(p.id);
      return { me: me(p.id) };
    },
    'GET /api/rank': (req) => {
      const p = authPlayer(bearer(req));
      return playerRankView(store.state, (id) => live(id)?.online ?? false, p.id);
    },
    'POST /api/ping': (req) => {
      const p = authPlayer(bearer(req));
      touch(p.id);
      return { me: me(p.id) };
    },
    'POST /api/settle': (req, b) => {
      const p = authPlayer(bearer(req));
      touch(p.id);
      store.run((s) => requestSettlement(s, { playerId: p.id, amount: b.amount, key: keyOf(b) }));
      return { me: me(p.id) };
    },
    'POST /api/settle/cancel': (req, b) => {
      const p = authPlayer(bearer(req));
      touch(p.id);
      store.run((s) => cancelSettlement(s, { id: b.id, by: 'player', playerId: p.id }));
      return { me: me(p.id) };
    },
    'POST /api/game/open': (req, b, _res, pub) => {
      const p = authPlayer(bearer(req));
      touch(p.id);
      const e = store.run((s) => openGame(s, { playerId: p.id, game: b.game, stake: b.stake, key: keyOf(b), online: pub }));
      if (e.type !== 'gameOpen') throw new LedgerError('bad_request');
      const { id, game, stake, secret } = e.session;
      return { session: { id, game, stake, secret, openedAt: e.at }, me: me(p.id) };
    },
    'POST /api/death/start': (req) => {
      const p = authPlayer(bearer(req));
      touch(p.id);
      if (!deathOpenFor(store.state, p)) throw new LedgerError('death_rich');
      const run: DeathRun = { id: randomUUID(), stage: 0, at: clock() };
      deathRuns.set(p.id, run);
      return { run: run.id };
    },
    'POST /api/death/stage': (req, b) => {
      const p = authPlayer(bearer(req));
      touch(p.id);
      const r = deathRun(p, b.run);
      if (b.stage === r.stage && r.stage > 0) return { ok: true }; // sent again (the answer was lost): already counted
      const now = clock();
      // In order, one at a time, and no faster than a person can play: anything else is a forged report.
      if (b.stage !== r.stage + 1 || r.stage >= T.deathStageMinMs.length || now - r.at < T.deathStageMinMs[r.stage]) {
        deathRuns.delete(p.id);
        throw new LedgerError('death_run');
      }
      r.stage++;
      r.at = now;
      return { ok: true };
    },
    'POST /api/death/clear': (req, b) => {
      const p = authPlayer(bearer(req));
      touch(p.id);
      const key = keyOf(b);
      if (!store.state.keys.has(key)) {
        // A repeated request (its answer was lost) finds its event by the key; a new one needs the whole run.
        if (deathRun(p, b.run).stage !== T.deathStageMinMs.length) throw new LedgerError('death_run');
        deathRuns.delete(p.id);
      }
      store.run((s) => clearDeathGame(s, { playerId: p.id, key }));
      return { me: me(p.id) };
    },
    'POST /api/roulette/rooms': (req) => {
      const p = authPlayer(bearer(req));
      touch(p.id);
      return { ...hall.list(p.id), free: p.chips };
    },
    'POST /api/roulette/create': (req, b) => {
      const p = authPlayer(bearer(req));
      touch(p.id);
      return hall.create(p, { stake: b.stake, lives: b.lives, key: keyOf(b) });
    },
    'POST /api/roulette/join': (req, b) => {
      const p = authPlayer(bearer(req));
      touch(p.id);
      return hall.join(p, b.room, keyOf(b));
    },
    'POST /api/roulette/cancel': (req, b) => {
      const p = authPlayer(bearer(req));
      hall.cancel(p.id, b.room);
      return { ok: true };
    },
    'POST /api/roulette/state': (req, b) => {
      const p = authPlayer(bearer(req));
      touch(p.id);
      return hall.state(p.id, b.room, b.after);
    },
    'POST /api/roulette/shoot': (req, b) => {
      const p = authPlayer(bearer(req));
      touch(p.id);
      return hall.shoot(p.id, b.room, b.target);
    },
    'POST /api/roulette/forfeit': (req, b) => {
      const p = authPlayer(bearer(req));
      hall.forfeit(p.id, b.room);
      return { ok: true };
    },
    'POST /api/message': (req, b) => {
      const p = authPlayer(bearer(req));
      touch(p.id);
      let times = messageTimes.get(p.id);
      if (!times) messageTimes.set(p.id, (times = []));
      limit(times, PLATFORM.message.perMin);
      store.run((s) => sendMessage(s, { playerId: p.id, text: b.text, key: keyOf(b) }));
      return { me: me(p.id) };
    },
    // Needs no login: the session secret is enough, so a game can report after a logout, a kick or a restart.
    'POST /api/game/close': (_req, b) => {
      const e = store.run((s) => closeGame(s, { id: b.id, payout: b.payout, secret: b.secret, by: 'player' }));
      const done = e.type === 'gameClose' || e.type === 'gameReview';
      return { me: done ? me(e.playerId) : null, review: e.type === 'gameReview' };
    },
  };

  const adminRoutes: Record<string, Handler> = {
    'GET /api/admin/state': () => ({ ...adminInfo(), log: store.state.log }),
    'GET /api/admin/rank': () => rankView(store.state, (id) => live(id)?.online ?? false, clock()),
    'POST /api/admin/edit': (_req, b) => {
      store.run((s) => edit(s, { id: b.id, version: b.version, name: b.name, pin: b.pin, total: b.total }));
      return { ok: true };
    },
    'POST /api/admin/delete': (_req, b) => {
      store.run((s) => remove(s, b.id));
      return { ok: true };
    },
    'POST /api/admin/settle': (_req, b) => {
      store.run((s) => directSettlement(s, { playerId: b.playerId, amount: b.amount, key: keyOf(b) }));
      return { ok: true };
    },
    'POST /api/admin/settle/done': (_req, b) => {
      store.run((s) => completeSettlement(s, b.id));
      return { ok: true };
    },
    'POST /api/admin/settle/reject': (_req, b) => {
      store.run((s) => cancelSettlement(s, { id: b.id, by: 'admin' }));
      return { ok: true };
    },
    'POST /api/admin/message/read': (_req, b) => {
      store.run((s) => readMessage(s, b.id));
      return { ok: true };
    },
    'POST /api/admin/game/close': (_req, b) => {
      store.run((s) => closeGame(s, { id: b.id, payout: b.payout, by: 'admin' }));
      return { ok: true };
    },
    'POST /api/admin/review': (_req, b) => {
      store.run((s) => decideReview(s, { id: b.id, approve: b.approve }));
      return { ok: true };
    },
    'POST /api/admin/online/code': () => {
      if (!online) throw new LedgerError('bad_request');
      entryCode = newCode();
      scheduleAdmin();
      return { code: entryCode };
    },
  };

  function openPlayerStream(req: IncomingMessage, res: ServerResponse, url: URL): void {
    sse(res);
    let p: Player;
    try {
      p = authPlayer(url.searchParams.get('token'));
    } catch {
      send(res, 'kicked', { reason: '다시 로그인하세요' });
      res.end();
      return;
    }
    const st: Stream = { res, login: p.login };
    let set = playerStreams.get(p.id);
    if (!set) playerStreams.set(p.id, (set = new Set()));
    set.add(st);
    touch(p.id);
    const view = me(p.id);
    if (view) send(res, 'me', view);
    req.on('close', () => {
      set.delete(st);
      if (set.size === 0 && playerStreams.get(p.id) === set) playerStreams.delete(p.id);
    });
  }

  function openAdminStream(req: IncomingMessage, res: ServerResponse): void {
    sse(res);
    const a: AdminStream = { res, logSent: store.state.log.length };
    send(res, 'snapshot', { ...adminInfo(), log: store.state.log });
    adminStreams.add(a);
    req.on('close', () => adminStreams.delete(a));
  }

  async function serveFile(res: ServerResponse, rel: string): Promise<void> {
    if (!o.staticDir) throw new HttpError(404, '화면 파일이 없습니다. npm run build를 먼저 하세요');
    const root = resolve(o.staticDir);
    const file = resolve(root, rel);
    if (file !== root && !file.startsWith(root + sep)) throw new HttpError(404, 'not found');
    let data: Buffer;
    try {
      data = await readFile(file);
    } catch {
      throw new HttpError(404, rel.endsWith('.html') ? '화면 파일이 없습니다. npm run build를 먼저 하세요' : 'not found');
    }
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  }

  function logCsv(res: ServerResponse): void {
    const rows = [['번호', '시각', '종류', '플레이어', '잔고 변화', '잔고', '내용']];
    for (const r of store.state.log) {
      rows.push([String(r.seq), localTime(r.at), LOG_LABEL[r.kind], r.name, String(r.delta), String(r.chips), r.text]);
    }
    const csv = rows.map((cols) => cols.map((c) => `"${c.replace(/"/g, '""')}"`).join(',')).join('\r\n');
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="db-log-${localTime(clock()).slice(0, 10)}.csv"`,
    });
    res.end(`\uFEFF${csv}`); // BOM: Excel reads it as UTF-8
  }

  async function handle(req: IncomingMessage, res: ServerResponse, pub: boolean): Promise<void> {
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://x');
    } catch {
      // A request line no URL can be made of must not take the server down.
      reply(res, 400, { error: 'bad_request', message: ERROR_TEXT.bad_request });
      return;
    }
    const path = url.pathname;
    const route = `${req.method} ${path}`;
    const isApi = path.startsWith('/api/');
    const isRank = path === '/rank' || path === '/rank.html'; // 순위 대시보드: on the admin PC (a projector), not online
    const isSim = path === '/sim' || path === '/sim.html'; // 확률 시뮬레이터: on the admin PC
    const isAdmin = path.startsWith('/api/admin/') || path === '/admin' || path === '/admin.html' || isRank || isSim;
    if (pub) {
      // The player app and the games come from this same address: no other site needs to read these answers,
      // frame these pages or sniff their types.
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('X-Frame-Options', 'SAMEORIGIN');
      res.setHeader('Referrer-Policy', 'no-referrer');
    }
    try {
      // Through the tunnel: no admin anything (not even its page) and no live updates. Checked first: the tunnel
      // connects from 127.0.0.1, which fromThisPc() would take for the admin PC.
      if (pub && (isAdmin || route === 'GET /api/events')) throw new HttpError(404, 'not found');
      if (isAdmin && !fromThisPc(req)) throw new LedgerError('forbidden');
      if (route === 'GET /api/events') return openPlayerStream(req, res, url);
      if (route === 'GET /api/admin/events') return openAdminStream(req, res);
      if (route === 'GET /api/admin/log.csv') return logCsv(res);
      const handler = playerRoutes[route] ?? adminRoutes[route];
      if (handler) {
        const body = req.method === 'POST' ? await readBody(req) : {};
        reply(res, 200, handler(req, body, res, pub));
        return;
      }
      if (isApi) throw new HttpError(404, 'not found');
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'method not allowed');
      if (path === '/' || path === '/index.html') return await serveFile(res, 'index.html');
      const game = /^\/games\/([a-z]+)\/(?:index\.html)?$/.exec(path)?.[1];
      if (game && (gameDef(game) || game === DEATH_GAME)) return await serveFile(res, `games/${game}/index.html`);
      if (isRank) return await serveFile(res, 'rank.html');
      if (isSim) return await serveFile(res, 'sim.html');
      if (isAdmin) return await serveFile(res, 'admin.html');
      if (path.startsWith('/assets/')) return await serveFile(res, path.slice(1));
      throw new HttpError(404, 'not found');
    } catch (err) {
      if (err instanceof LedgerError) {
        reply(res, STATUS[err.code] ?? 400, { error: err.code, message: ERROR_TEXT[err.code] });
      } else if (err instanceof HttpError) {
        reply(res, err.status, { error: 'bad_request', message: err.message });
      } else {
        console.error(err);
        reply(res, 500, { error: 'bad_request', message: '서버 오류' });
      }
    }
  }

  const server = createServer((req, res) => void handle(req, res, false));
  const publicServer = online ? createServer((req, res) => void handle(req, res, true)) : null;
  try {
    await listen(server, o.port ?? PLATFORM.port, o.host ?? '127.0.0.1');
    if (publicServer) await listen(publicServer, o.publicPort ?? PLATFORM.online.publicPort, '127.0.0.1');
  } catch (e) {
    clearInterval(sweep);
    clearInterval(keepAlive);
    clearInterval(hallTimer);
    if (server.listening) server.close();
    store.close();
    throw e;
  }
  const port = (server.address() as AddressInfo).port;
  const publicPort = publicServer ? (publicServer.address() as AddressInfo).port : null;
  if (publicPort !== null && o.tunnel) {
    tunnel = startTunnel({ exe: o.tunnel.exe, port: publicPort, restartMs: PLATFORM.online.tunnelRestartMs, onChange: () => scheduleAdmin() });
  }

  return {
    port,
    publicPort,
    tunnel: () => tunnel?.state() ?? null,
    url: `http://127.0.0.1:${port}/`, // not "localhost": that may mean IPv6, and the server listens on IPv4
    store,
    async close() {
      for (const id of [...presence.keys()]) goOffline(id); // saves everyone's online time
      clearInterval(hallTimer);
      hall.closeAll(); // rooms still running: their stakes go back
      closing = true;
      tunnel?.stop();
      clearInterval(sweep);
      clearInterval(keepAlive);
      if (adminTimer) clearTimeout(adminTimer);
      for (const set of playerStreams.values()) for (const st of set) st.res.end();
      for (const a of adminStreams) a.res.end();
      for (const s of [server, publicServer]) {
        if (!s) continue;
        await new Promise<void>((done) => {
          s.close(() => done());
          s.closeAllConnections();
        });
      }
      store.close();
    },
  };
}

function listen(s: Server, port: number, host: string): Promise<void> {
  return new Promise<void>((done, fail) => {
    s.once('error', (e: NodeJS.ErrnoException) =>
      fail(
        e.code === 'EADDRINUSE'
          ? new Error(`포트 ${port}을 이미 쓰고 있습니다. 장부 서버가 벌써 켜져 있는지 확인하세요.`, { cause: e })
          : e,
      ),
    );
    s.listen(port, host, () => done());
  });
}

/** The place a request comes from, for the tunnel's limits: an IPv4 address, or the /64 an IPv6 address is in. */
export function ipKey(ip: string): string {
  const v4 = /^(?:::ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (v4) return v4[1];
  if (!ip.includes(':')) return ip || 'unknown';
  const [head, tail] = ip.toLowerCase().split('::');
  const h = head ? head.split(':') : [];
  const t = tail === undefined ? [] : tail ? tail.split(':') : [];
  const groups = [...h, ...Array<string>(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t];
  return `${groups
    .slice(0, 4)
    .map((g) => g.replace(/^0+(?=.)/, ''))
    .join(':')}::/64`;
}

/** The 데스 게임's page (games/deathgame): not a chip game, it pays PLATFORM.deathGame.reward once cleared. */
const DEATH_GAME = 'deathgame';

/** A new 입장 코드: random digits, leading zeros kept. */
const newCode = (): string => String(randomInt(0, 10 ** PLATFORM.online.entryDigits)).padStart(PLATFORM.online.entryDigits, '0');

/** The player whose app should hear about this event. */
function affected(e: LedgerEvent): string | null {
  switch (e.type) {
    case 'signup':
      return e.player.id;
    case 'login':
    case 'logout':
    case 'activity':
    case 'edit':
    case 'delete':
      return e.id;
    case 'gameOpen':
      return e.session.playerId;
    case 'settleRequest':
      return e.settlement.playerId;
    case 'message':
      return e.message.playerId;
    case 'messageRead':
      return null; // the player sees it on the next report
    case 'duelEnd':
      return null; // two players: each one's game asks for news
    default:
      return e.playerId;
  }
}

/** The admin PC itself: loopback, or a connection from one of this PC's own addresses. */
function fromThisPc(req: IncomingMessage): boolean {
  const remote = (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
  const local = (req.socket.localAddress ?? '').replace(/^::ffff:/, '');
  return remote === '127.0.0.1' || remote === '::1' || remote === local;
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 16_384) throw new HttpError(413, '요청이 너무 큽니다');
    chunks.push(c as Buffer);
  }
  if (!size) return {};
  try {
    const v: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {
    // falls through
  }
  throw new LedgerError('bad_request');
}

function reply(res: ServerResponse, status: number, data: unknown): void {
  if (res.headersSent) return;
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(data));
}

function localTime(ms: number): string {
  const d = new Date(ms);
  const z = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())}:${z(d.getSeconds())}`;
}

export const staticDirDefault = (): string => join(import.meta.dirname, '..', '..', 'dist');

export const fromThisPcForTest = fromThisPc;
