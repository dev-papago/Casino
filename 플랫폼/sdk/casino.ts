// Chip bridge for a game inside the casino platform. One self-contained file that
// 야바위 and 영끌문S both import. The player app opens a game from the ledger server with ?casino in its URL, so the
// game shares the app's origin and its login. A game session:
//
//   open(game, stake)        takes the stake out of the player's free chips (it waits in the ledger as "게임 중")
//   live(session, payout)    the game notes, after every change, what the player would get back if it ended now
//   close(session, payout)   gives the result back in chips ('review': a big win through the tunnel waits for the
//                            admin before it reaches the balance)
//
// Nothing here can be lost to a dropped Wi-Fi, a reload or a closed window. open() writes its request key down
// first, so a cut-off request is found again. close() puts the result in an outbox first and sends it until the
// server has it; the player app empties the same outbox on every report. A game that stops without close() (a
// reload, the window closed, another PC logged in) is settled at its last live() value by settleLeftovers(),
// which the player app and the next game start run. The server takes each key and each session's result once.

const TOKEN_KEY = 'casino:v1:token';
const OUTBOX_KEY = 'casino:v1:outbox';
const INTENT_KEY = 'casino:v1:opening';
const LIVE_KEY = 'casino:v1:live';

export interface CasinoPlayer {
  id: string;
  name: string;
  free: number; // chips the player can take into a game
  total: number;
  held: number; // held for a settlement request
  games: { game: string; stake: number }[]; // open game sessions
}

/**
 * 승리 추세: the games pull every guest's chips (in all) toward a center, so over many rounds the balances settle
 * into a skewed bell: a short left side (few go broke) and a long right tail toward 50. A result that would leave
 * the guest further from the center than now is drawn again (or the round eased or tightened) unless it is kept,
 * with chance e^(u(before) − u(after)); u grows with the distance in ln(chips / center), quadratically: `left`
 * below the center, `right` above it. A result toward the center always stands. Going broke counts like losing
 * all but 1/bust of the balance. Each game sets its own numbers (the skill games a higher center), tuned with the
 * 확률 시뮬레이터 (/sim); 야바위 (an easier or harder shuffle) and 영끌문S (a 배당금) have their own forms.
 * A guest who settles while ahead does better than one who plays on: the price of the bell (the user's choice).
 */
export interface Tilt {
  center: number;
  left: number;
  right: number;
  bust: number;
}

/** The chance that a result taking the guest from `before` to `after` chips (in all) stands. */
export function keepChance(before: number, after: number, t: Tilt): number {
  const u = (x: number): number => {
    const d = Math.log(x / t.center);
    return (d < 0 ? t.left : t.right) * d * d;
  };
  const b = Math.max(1, before);
  return Math.min(1, Math.exp(u(b) - u(after > 0 ? after : b / t.bust)));
}

let lastSeen: CasinoPlayer | null = null;

/** The player's chips outside `game` and outside its free balance (held, in other games), as last read. */
export function chipsElsewhere(game: string): number {
  if (!lastSeen) return 0;
  return lastSeen.held + lastSeen.games.reduce((a, g) => a + (g.game === game ? 0 : g.stake), 0);
}

export interface CasinoSession {
  id: string;
  secret: string;
  game: string;
  stake: number;
  playerId: string;
}

interface Closing {
  id: string;
  secret: string;
  payout: number;
  game: string;
}

/** A running session and what it would pay out now. */
interface Live extends Closing {
  playerId: string;
}

interface Opening {
  game: string;
  stake: number;
  key: string;
  playerId: string;
}

export class CasinoError extends Error {
  readonly code: string; // the server's error code, or 'network'
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** True when the player app opened this game (?casino in the URL). */
export const inCasino = (): boolean => typeof location !== 'undefined' && new URLSearchParams(location.search).has('casino');

const base = (): string => `${location.origin}/`;
const token = (): string => raw(TOKEN_KEY) ?? '';

/** The logged-in player; throws CasinoError 'session' when nobody is logged in on this PC. */
export async function player(): Promise<CasinoPlayer> {
  const r = await call<{ me: CasinoPlayer }>('me', undefined, { auth: true, retryMs: 10_000 });
  lastSeen = r.me;
  return r.me;
}

/** Takes `stake` chips into `game`. A reload during the request is picked up by settleLeftovers(). */
export async function open(game: string, stake: number, playerId: string): Promise<CasinoSession> {
  const intent: Opening = { game, stake, key: newKey(), playerId };
  write(INTENT_KEY, intent);
  try {
    const s = await sendOpen(intent);
    live(s, s.stake); // until the game says otherwise, stopping now gives the stake back
    remove(INTENT_KEY);
    return s;
  } catch (e) {
    // A definite no (not enough chips, logged out): nothing was taken. Unreachable server: keep the intent.
    if (!(e instanceof CasinoError) || e.code !== 'network') remove(INTENT_KEY);
    throw e;
  }
}

/**
 * Settles every game session on this PC that stopped without close(): at its last live() value, or with the
 * stake back when open() was cut short before the game began. `game` limits it to one game (a game starting up
 * must not settle another game that is still running in the same app); `except` skips a session still running.
 */
export async function settleLeftovers(game?: string, except?: string): Promise<number> {
  const intent = read<Opening>(INTENT_KEY);
  if (intent && (!game || intent.game === game)) {
    try {
      const s = await sendOpen(intent);
      remove(INTENT_KEY);
      await close(s, s.stake);
    } catch (e) {
      if (!(e instanceof CasinoError) || e.code !== 'network') remove(INTENT_KEY);
    }
  }
  const left = Object.values(lives()).filter((l) => (!game || l.game === game) && l.id !== except);
  for (const l of left) await close({ id: l.id, secret: l.secret, game: l.game, stake: 0, playerId: l.playerId }, l.payout);
  return left.length;
}

/** Notes what the session would pay out if the game stopped right now. */
export function live(s: CasinoSession, payout: number): void {
  write(LIVE_KEY, { ...lives(), [s.id]: { id: s.id, secret: s.secret, game: s.game, payout, playerId: s.playerId } });
}

async function sendOpen(o: Opening): Promise<CasinoSession> {
  const r = await call<{ session: { id: string; secret: string; game: string; stake: number } }>(
    'game/open',
    { game: o.game, stake: o.stake, key: o.key },
    { auth: true, retryMs: 20_000 },
  );
  return { ...r.session, playerId: o.playerId };
}

/** Sessions whose result the ledger took but holds for the admin (a big win through the tunnel). */
const inReview = new Set<string>();

/**
 * Gives the result back. 'sent': the ledger has it; 'queued': it waits in the outbox until the server is back;
 * 'review': the ledger has it and pays it out once the admin approves.
 */
export async function close(s: CasinoSession, payout: number): Promise<'sent' | 'queued' | 'review'> {
  const box = outbox().filter((c) => c.id !== s.id);
  box.push({ id: s.id, secret: s.secret, payout, game: s.game });
  write(OUTBOX_KEY, box);
  const rest = lives();
  delete rest[s.id];
  write(LIVE_KEY, rest);
  if (!outbox().some((c) => c.id === s.id)) {
    // Storage is blocked: no outbox, so this one try is all there is.
    const r = await call<{ review?: boolean }>('game/close', { id: s.id, secret: s.secret, payout }, { auth: false, retryMs: 20_000 });
    return r.review ? 'review' : 'sent';
  }
  await flush();
  return outbox().some((c) => c.id === s.id) ? 'queued' : inReview.has(s.id) ? 'review' : 'sent';
}

let flushing: Promise<number> | null = null;

/** Sends every result waiting in the outbox; returns how many are still waiting (server unreachable). */
export function flush(): Promise<number> {
  // One run at a time. (Cleared in a .finally: an empty outbox finishes the run before it could be stored.)
  flushing ??= sendOutbox().finally(() => {
    flushing = null;
  });
  return flushing;
}

async function sendOutbox(): Promise<number> {
  for (const c of outbox()) {
    try {
      const r = await call<{ review?: boolean }>('game/close', { id: c.id, secret: c.secret, payout: c.payout }, { auth: false, retryMs: 0 });
      if (r?.review) inReview.add(c.id);
    } catch (e) {
      if (e instanceof CasinoError && e.code === 'network') continue; // try again later
      // Any other answer is final (already closed, closed by the admin, over the limit): the admin sees the rest.
    }
    write(OUTBOX_KEY, outbox().filter((x) => x.id !== c.id));
  }
  return outbox().length;
}

/** Results still waiting for the server. */
export const waiting = (): number => outbox().length;

// ------------------------------------------------------------------ 데스 게임

/** Starts a 데스 게임 run: the server follows it (only for a player with too few chips for the games). */
export async function deathStart(): Promise<string> {
  return (await call<{ run: string }>('death/start', {}, { auth: true, retryMs: 10_000 })).run;
}

/** Stage `stage` (1–5) of the run is cleared. Sending it again is harmless. */
export async function deathStage(run: string, stage: number): Promise<void> {
  await call('death/stage', { run, stage }, { auth: true, retryMs: 20_000 });
}

/** Every stage cleared: the reward goes to the balance. `key` makes a repeat (after a lost answer) count once. */
export async function deathClear(run: string, key: string): Promise<CasinoPlayer> {
  const r = await call<{ me: CasinoPlayer }>('death/clear', { run, key }, { auth: true, retryMs: 20_000 });
  lastSeen = r.me;
  return r.me;
}

// ------------------------------------------------------------------ games the server runs (러시안 룰렛)

/** A logged-in request to the server's API (`path` under /api/); a dropped connection is tried again for `retryMs`. */
export function request<T>(path: string, body: unknown = {}, retryMs = 4_000): Promise<T> {
  return call<T>(path, body, { auth: true, retryMs });
}

/** Back to the player app: closes the game window opened by the app, or goes to the app's page. */
export function exit(): void {
  if (window.parent !== window) window.parent.postMessage({ type: 'casino:exit' }, location.origin);
  else location.href = base();
}

// ------------------------------------------------------------------ plumbing

async function call<T>(path: string, body: unknown, o: { auth: boolean; retryMs: number }): Promise<T> {
  const end = Date.now() + o.retryMs;
  for (let attempt = 0; ; attempt++) {
    try {
      return await once<T>(path, body, o.auth);
    } catch (e) {
      if (!(e instanceof CasinoError) || e.code !== 'network' || Date.now() >= end) throw e;
      await new Promise((r) => setTimeout(r, Math.min(3000, 400 * 2 ** attempt)));
    }
  }
}

async function once<T>(path: string, body: unknown, auth: boolean): Promise<T> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 8000);
  let res: Response;
  try {
    res = await fetch(`${base()}api/${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${token()}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctl.signal,
    });
  } catch {
    throw new CasinoError('network', '서버에 연결할 수 없습니다');
  } finally {
    clearTimeout(timer);
  }
  const data = (await res.json().catch(() => null)) as { error?: string; message?: string } | null;
  if (res.status >= 500) throw new CasinoError('network', '서버 오류');
  if (!res.ok) throw new CasinoError(data?.error ?? 'bad_request', data?.message ?? '오류');
  return data as T;
}

const outbox = (): Closing[] => read<Closing[]>(OUTBOX_KEY) ?? [];
const lives = (): Record<string, Live> => read<Record<string, Live>>(LIVE_KEY) ?? {};

const newKey = (): string =>
  globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

function raw(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function read<T>(key: string): T | null {
  try {
    const v = raw(key);
    return v == null ? null : (JSON.parse(v) as T);
  } catch {
    return null;
  }
}
function write(key: string, v: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    // storage blocked: the result still goes out now, it just cannot wait for a later try
  }
}
function remove(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // nothing stored
  }
}
