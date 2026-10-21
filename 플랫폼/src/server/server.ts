// The ledger server on the admin PC (DESIGN.md section 4). Plain node:http, no packages: JSON requests, and
// server-sent events for live updates to the player apps and the admin screen. Player endpoints are open to the
// Wi-Fi; the admin page and admin endpoints answer only to the admin PC itself.
//
// Online means the player app reported in within PLATFORM.offlineAfterMs (it does every PLATFORM.pingMs). A
// connection alone proves nothing: a laptop that walks out of the Wi-Fi leaves its connection open for minutes.
import { createSocket } from 'node:dgram';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { networkInterfaces } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PLATFORM, gameDef } from '../shared/config.ts';
import { ERROR_TEXT, LOG_LABEL, type AdminState, type ErrorCode, type LanUrl } from '../shared/protocol.ts';
import {
  LedgerError,
  activity,
  cancelSettlement,
  cleanName,
  closeGame,
  completeSettlement,
  directSettlement,
  edit,
  login,
  logout,
  nameKey,
  openGame,
  remove,
  requestSettlement,
  resolveBankruptcy,
  signup,
  type LedgerEvent,
  type Player,
} from './ledger.ts';
import { Store } from './store.ts';
import { adminState, playerView, type Live } from './views.ts';

export interface ServerOptions {
  dataDir: string;
  port?: number; // 0: any free port (tests)
  host?: string;
  staticDir?: string; // the built pages and games; without it only the API answers
  discoveryPort?: number | null; // UDP port answering player PCs that look for the server (null: none)
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
}

export interface RunningServer {
  port: number;
  url: string; // on this PC
  urls: LanUrl[]; // for the player PCs on the Wi-Fi
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
  locked: 429,
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
    ...o.timing,
  };
  const store = new Store(o.dataDir, clock);
  const dataDir = resolve(o.dataDir);
  const startedAt = clock();
  const presence = new Map<string, Segment>();
  const fails = new Map<string, { count: number; until: number }>();
  const playerStreams = new Map<string, Set<Stream>>();
  const adminStreams = new Set<AdminStream>();
  let urls: LanUrl[] = [];
  let adminTimer: NodeJS.Timeout | null = null;
  let closing = false;

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

  function sse(res: ServerResponse, cors: boolean): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      ...(cors ? { 'Access-Control-Allow-Origin': '*' } : {}),
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

  const adminInfo = (): AdminState => adminState(store.state, live, clock(), { urls, dataDir, startedAt });

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
  type Handler = (req: IncomingMessage, body: Body, res: ServerResponse) => unknown;

  const playerRoutes: Record<string, Handler> = {
    'POST /api/signup': (_req, b) => {
      const e = store.run((s) => signup(s, { name: b.name, pin: b.pin, key: keyOf(b) }));
      if (e.type !== 'signup') throw new LedgerError('bad_request');
      const p = store.state.players.get(e.player.id);
      if (!p || p.login !== e.player.login) throw new LedgerError('session'); // replayed after a newer login
      touch(p.id);
      return { token: tokenOf(p), me: me(p.id) };
    },
    'POST /api/login': (_req, b) => {
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
    'POST /api/game/open': (req, b) => {
      const p = authPlayer(bearer(req));
      touch(p.id);
      const e = store.run((s) => openGame(s, { playerId: p.id, game: b.game, stake: b.stake, key: keyOf(b) }));
      if (e.type !== 'gameOpen') throw new LedgerError('bad_request');
      const { id, game, stake, secret } = e.session;
      return { session: { id, game, stake, secret, openedAt: e.at }, me: me(p.id) };
    },
    // Needs no login: the session secret is enough, so a game can report after a logout, a kick or a restart.
    'POST /api/game/close': (_req, b) => {
      const e = store.run((s) => closeGame(s, { id: b.id, payout: b.payout, secret: b.secret, by: 'player' }));
      return { me: e.type === 'gameClose' ? me(e.playerId) : null };
    },
  };

  const adminRoutes: Record<string, Handler> = {
    'GET /api/admin/state': () => ({ ...adminInfo(), log: store.state.log }),
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
    'POST /api/admin/bankrupt/done': (_req, b) => {
      store.run((s) => resolveBankruptcy(s, b.id));
      return { ok: true };
    },
    'POST /api/admin/game/close': (_req, b) => {
      store.run((s) => closeGame(s, { id: b.id, payout: b.payout, by: 'admin' }));
      return { ok: true };
    },
  };

  function openPlayerStream(req: IncomingMessage, res: ServerResponse, url: URL): void {
    sse(res, true);
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
    sse(res, false);
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

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://x');
    const path = url.pathname;
    const route = `${req.method} ${path}`;
    const isApi = path.startsWith('/api/');
    const isAdmin = path.startsWith('/api/admin/') || path === '/admin' || path === '/admin.html';
    try {
      if (isAdmin && !fromThisPc(req)) throw new LedgerError('forbidden');
      if (isApi && !isAdmin && req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
          'Access-Control-Max-Age': '600',
        });
        res.end();
        return;
      }
      if (route === 'GET /api/events') return openPlayerStream(req, res, url);
      if (route === 'GET /api/admin/events') return openAdminStream(req, res);
      if (route === 'GET /api/admin/log.csv') return logCsv(res);
      const handler = playerRoutes[route] ?? adminRoutes[route];
      if (handler) {
        const body = req.method === 'POST' ? await readBody(req) : {};
        reply(res, 200, handler(req, body, res), !isAdmin);
        return;
      }
      if (isApi) throw new HttpError(404, 'not found');
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'method not allowed');
      if (path === '/' || path === '/index.html') return await serveFile(res, 'index.html');
      const game = /^\/games\/([a-z]+)\/(?:index\.html)?$/.exec(path)?.[1];
      if (game && gameDef(game)) return await serveFile(res, `games/${game}/index.html`);
      if (isAdmin) return await serveFile(res, 'admin.html');
      if (path.startsWith('/assets/')) return await serveFile(res, path.slice(1));
      throw new HttpError(404, 'not found');
    } catch (err) {
      if (err instanceof LedgerError) {
        reply(res, STATUS[err.code] ?? 400, { error: err.code, message: ERROR_TEXT[err.code] }, !isAdmin);
      } else if (err instanceof HttpError) {
        reply(res, err.status, { error: 'bad_request', message: err.message }, !isAdmin);
      } else {
        console.error(err);
        reply(res, 500, { error: 'bad_request', message: '서버 오류' }, !isAdmin);
      }
    }
  }

  const server = createServer((req, res) => void handle(req, res));
  try {
    await new Promise<void>((done, fail) => {
      server.once('error', fail);
      server.listen(o.port ?? PLATFORM.port, o.host ?? '0.0.0.0', () => done());
    });
  } catch (e) {
    clearInterval(sweep);
    clearInterval(keepAlive);
    store.close();
    if ((e as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      throw new Error(`포트 ${o.port ?? PLATFORM.port}을 이미 쓰고 있습니다. 장부 서버가 벌써 켜져 있는지 확인하세요.`, { cause: e });
    }
    throw e;
  }
  const port = (server.address() as AddressInfo).port;
  urls = lanUrls(port);
  const discovery = o.discoveryPort === null ? null : answerDiscovery(o.discoveryPort ?? PLATFORM.discoveryPort, port);

  return {
    port,
    url: `http://127.0.0.1:${port}/`, // not "localhost": that may mean IPv6, and the server listens on IPv4
    urls,
    store,
    async close() {
      for (const id of [...presence.keys()]) goOffline(id); // saves everyone's online time
      closing = true;
      discovery?.close();
      clearInterval(sweep);
      clearInterval(keepAlive);
      if (adminTimer) clearTimeout(adminTimer);
      for (const set of playerStreams.values()) for (const st of set) st.res.end();
      for (const a of adminStreams) a.res.end();
      await new Promise<void>((done) => {
        server.close(() => done());
        server.closeAllConnections();
      });
      store.close();
    },
  };
}

export const DISCOVERY_QUESTION = 'CASINO?';

/**
 * Answers player PCs looking for the server: they broadcast "CASINO?" on the Wi-Fi and get back the HTTP port,
 * and the answer's sender address is the server. A taken port only costs the automatic search.
 */
function answerDiscovery(udpPort: number, httpPort: number): { close(): void } | null {
  const sock = createSocket({ type: 'udp4', reuseAddr: true });
  sock.on('error', (e) => {
    console.warn(`자동 찾기(UDP ${udpPort})를 켜지 못했습니다: ${e.message}`);
    sock.close();
  });
  sock.on('message', (msg, from) => {
    if (msg.toString() !== DISCOVERY_QUESTION) return;
    sock.send(JSON.stringify({ casino: true, port: httpPort }), from.port, from.address);
  });
  sock.bind(udpPort);
  return { close: () => sock.close() };
}

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

function reply(res: ServerResponse, status: number, data: unknown, cors: boolean): void {
  if (res.headersSent) return;
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...(cors ? { 'Access-Control-Allow-Origin': '*' } : {}),
  });
  res.end(JSON.stringify(data));
}

/** http://<address>:<port>/ for every IPv4 address of this PC, Wi-Fi first and virtual adapters last. */
export function lanUrls(port: number): LanUrl[] {
  const out: LanUrl[] = [];
  for (const [name, list] of Object.entries(networkInterfaces())) {
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) out.push({ name, url: `http://${a.address}:${port}/` });
  }
  const rank = (n: string): number =>
    /wi-?fi|wlan|wireless|무선/i.test(n) ? 0 : /vethernet|virtual|vmware|vbox|docker|wsl|loopback|tailscale|zerotier|vpn/i.test(n) ? 2 : 1;
  return out.sort((a, b) => rank(a.name) - rank(b.name));
}

function localTime(ms: number): string {
  const d = new Date(ms);
  const z = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())}:${z(d.getSeconds())}`;
}

export const staticDirDefault = (): string => join(import.meta.dirname, '..', '..', 'dist');

export const fromThisPcForTest = fromThisPc;
