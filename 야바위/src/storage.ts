// localStorage persistence. Every read and write is wrapped so a blocked or corrupt store falls back to defaults.
import { LEVEL_IDS, type LevelId } from './config';
import { END_REASONS, sessionNet, type EndReason, type Session } from './game/session';

// v2: per-round level and bet; a v1 session from the old rules is not resumed.
export const SETTINGS_KEY = 'yabawi:v2:settings';
export const STATE_KEY = 'yabawi:v2:state';

export interface Stats {
  levels: Record<LevelId, { rounds: number; hits: number }>; // updated every round
  sessions: number; // updated at 지급 완료
  chipsIn: number;
  chipsOut: number;
  endReasons: Record<EndReason, number>;
  nets: Record<string, number>; // histogram: session net -> count
}
export interface SavedState {
  session: Session | null;
  stats: Stats;
}

export function emptyStats(): Stats {
  return {
    levels: Object.fromEntries(LEVEL_IDS.map((id) => [id, { rounds: 0, hits: 0 }])) as Stats['levels'],
    sessions: 0,
    chipsIn: 0,
    chipsOut: 0,
    endReasons: { broke: 0, quit: 0, cap: 0 },
    nets: {},
  };
}

export function emptyState(): SavedState {
  return { session: null, stats: emptyStats() };
}

/** Counts one round (practice or paid). */
export function recordRound(stats: Stats, level: LevelId, win: boolean): Stats {
  const lv = stats.levels[level];
  return { ...stats, levels: { ...stats.levels, [level]: { rounds: lv.rounds + 1, hits: lv.hits + (win ? 1 : 0) } } };
}

/** Counts a finished session at 지급 완료. */
export function recordPayout(stats: Stats, s: Session): Stats {
  if (!s.ended) throw new Error('session has not ended');
  const net = String(sessionNet(s));
  return {
    ...stats,
    sessions: stats.sessions + 1,
    chipsIn: stats.chipsIn + s.econ.buyIn,
    chipsOut: stats.chipsOut + s.stack,
    endReasons: { ...stats.endReasons, [s.ended]: stats.endReasons[s.ended] + 1 },
    nets: { ...stats.nets, [net]: (stats.nets[net] ?? 0) + 1 },
  };
}

export function readJson(key: string): unknown {
  try {
    const raw = globalThis.localStorage?.getItem(key);
    return raw == null ? null : (JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

export function writeJson(key: string, value: unknown): boolean {
  try {
    globalThis.localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- shape checks (corrupt data, not cheating)

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

function toStats(raw: unknown): Stats {
  const st = emptyStats();
  if (!isObj(raw)) return st;
  const levels = isObj(raw.levels) ? raw.levels : {};
  for (const id of Object.keys(st.levels) as LevelId[]) {
    const lv = isObj(levels[id]) ? levels[id] : {};
    st.levels[id] = { rounds: num(lv.rounds), hits: num(lv.hits) };
  }
  st.sessions = num(raw.sessions);
  st.chipsIn = num(raw.chipsIn);
  st.chipsOut = num(raw.chipsOut);
  const ends = isObj(raw.endReasons) ? raw.endReasons : {};
  for (const r of END_REASONS) st.endReasons[r] = num(ends[r]);
  if (isObj(raw.nets)) for (const [k, v] of Object.entries(raw.nets)) if (num(v) > 0) st.nets[k] = num(v);
  return st;
}

function toSession(raw: unknown): Session | null {
  if (!isObj(raw) || !isObj(raw.econ) || !Array.isArray(raw.rounds)) return null;
  if (typeof raw.id !== 'string' || typeof raw.startedAt !== 'number' || typeof raw.stack !== 'number') return null;
  if (raw.ended !== null && !END_REASONS.includes(raw.ended as EndReason)) return null;
  return raw as unknown as Session;
}

export function loadState(): SavedState {
  const raw = readJson(STATE_KEY);
  if (!isObj(raw)) return emptyState();
  return { session: toSession(raw.session), stats: toStats(raw.stats) };
}

/** Writes session and stats together in one setItem so they never disagree. */
export function saveState(state: SavedState): boolean {
  return writeJson(STATE_KEY, state);
}
