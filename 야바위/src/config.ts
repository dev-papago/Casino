import defaults from './config/defaults.json';
import { SETTINGS_KEY, readJson, writeJson } from './storage';

export type GameConfig = typeof defaults; // ranges are inclusive [min, max]; mix weights are relative
export type LevelId = keyof GameConfig['levels']; // 'easy' | 'normal' | 'high' | 'hardest'
export type LevelConfig = GameConfig['levels'][LevelId];
export type ShuffleConfig = LevelConfig['shuffle'];
export type TimingConfig = GameConfig['timing'];
export type EconomyConfig = GameConfig['economy'];
export interface Settings {
  pin: string;
  sound: GameConfig['sound'];
} // admin screen

export const CONFIG: GameConfig = defaults;
export const LEVEL_IDS = Object.keys(defaults.levels) as LevelId[];
/** Levels that take chips (multiplier > 0); the rest are free practice. */
export const PAID_LEVELS = LEVEL_IDS.filter((id) => defaults.levels[id].paid);

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

export function defaultSettings(cfg: GameConfig = CONFIG): Settings {
  return { pin: cfg.pin, sound: { ...cfg.sound } };
}

/** Merges whatever was stored over the defaults, field by field (an old stored maxBet is dropped). */
export function normalizeSettings(raw: unknown, cfg: GameConfig = CONFIG): Settings {
  const d = defaultSettings(cfg);
  if (!isObj(raw)) return d;
  const sound = isObj(raw.sound) ? raw.sound : {};
  const vol = typeof sound.volume === 'number' && Number.isFinite(sound.volume) ? sound.volume : d.sound.volume;
  return {
    pin: typeof raw.pin === 'string' && raw.pin.length > 0 ? raw.pin : d.pin,
    sound: {
      muted: typeof sound.muted === 'boolean' ? sound.muted : d.sound.muted,
      volume: Math.min(1, Math.max(0, vol)),
    },
  };
}

export function loadSettings(): Settings {
  return normalizeSettings(readJson(SETTINGS_KEY));
}

/** Saves the normalized settings and returns what was saved. */
export function saveSettings(s: Settings): Settings {
  const n = normalizeSettings(s);
  writeJson(SETTINGS_KEY, n);
  return n;
}

/** Economy snapshot for a new session (defaults.json economy; nothing in it is set from the admin screen). */
export function sessionEconomy(_settings: Settings, cfg: GameConfig = CONFIG): EconomyConfig {
  return { ...cfg.economy };
}
