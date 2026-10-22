// Synthesized sound effects for the arcade games (Web Audio, no files). The first click unlocks audio.
let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let noise: AudioBuffer | null = null;
let muted = false;

const MUTE_KEY = 'arcade:muted';
try {
  muted = localStorage.getItem(MUTE_KEY) === '1';
} catch {
  // storage blocked: sound on
}

export function unlock(): void {
  try {
    if (!ctx) {
      ctx = new AudioContext();
      master = ctx.createGain();
      master.gain.value = muted ? 0 : 0.5;
      master.connect(ctx.destination);
      noise = ctx.createBuffer(1, ctx.sampleRate * 0.5, ctx.sampleRate);
      const d = noise.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    if (ctx.state === 'suspended') void ctx.resume();
  } catch {
    ctx = null;
  }
}

export const isMuted = (): boolean => muted;

export function setMuted(m: boolean): void {
  muted = m;
  if (master) master.gain.value = m ? 0 : 0.5;
  try {
    localStorage.setItem(MUTE_KEY, m ? '1' : '0');
  } catch {
    // not remembered
  }
}

function ready(): AudioContext | null {
  return ctx && master && ctx.state === 'running' && !muted ? ctx : null;
}

/** One note: frequency, start (s from now), length (s), wave, volume, optional slide to another frequency. */
export function tone(freq: number, at = 0, len = 0.1, type: OscillatorType = 'sine', vol = 0.2, slideTo?: number): void {
  const c = ready();
  if (!c || !master) return;
  const t = c.currentTime + at;
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + len);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t + len);
  o.connect(g).connect(master);
  o.start(t);
  o.stop(t + len + 0.02);
}

/** A burst of filtered noise (dice rattle, reel thunk). */
export function hiss(at = 0, len = 0.08, freq = 2000, vol = 0.2, q = 1): void {
  const c = ready();
  if (!c || !master || !noise) return;
  const t = c.currentTime + at;
  const src = c.createBufferSource();
  src.buffer = noise;
  const f = c.createBiquadFilter();
  f.type = 'bandpass';
  f.frequency.value = freq;
  f.Q.value = q;
  const g = c.createGain();
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + len);
  src.connect(f).connect(g).connect(master);
  src.start(t, Math.random() * 0.3);
  src.stop(t + len + 0.02);
}

export const sfx = {
  click: () => tone(880, 0, 0.04, 'square', 0.05),
  bet: () => tone(660, 0, 0.05, 'triangle', 0.12),
  peg: (i: number) => tone(520 + ((i * 97) % 600), 0, 0.05, 'sine', 0.08),
  thunk: () => {
    hiss(0, 0.07, 400, 0.35, 2);
    tone(110, 0, 0.12, 'sine', 0.25, 60);
  },
  tick: () => hiss(0, 0.025, 3500, 0.06, 3),
  rattle: () => {
    for (let i = 0; i < 6; i++) hiss(i * 0.07 + Math.random() * 0.03, 0.04, 2500 + Math.random() * 1500, 0.18, 4);
  },
  lose: () => {
    tone(330, 0, 0.18, 'triangle', 0.12, 220);
    tone(220, 0.16, 0.3, 'triangle', 0.1, 150);
  },
  push: () => tone(523, 0, 0.18, 'triangle', 0.12),
  win: () => [523, 659, 784].forEach((f, i) => tone(f, i * 0.08, 0.16, 'triangle', 0.16)),
  bigWin: () => {
    [523, 659, 784, 1047, 784, 1047, 1319].forEach((f, i) => tone(f, i * 0.09, 0.2, 'square', 0.09));
    [262, 392, 523].forEach((f) => tone(f, 0.63, 0.7, 'sawtooth', 0.06));
    for (let i = 0; i < 10; i++) tone(1800 + Math.random() * 1500, 0.7 + i * 0.06, 0.08, 'sine', 0.05);
  },
  jackpot: () => {
    for (let r = 0; r < 3; r++) [523, 659, 784, 1047].forEach((f, i) => tone(f * (1 + r * 0.125), r * 0.42 + i * 0.07, 0.22, 'square', 0.08));
    [262, 330, 392, 523].forEach((f) => tone(f, 1.3, 1.2, 'sawtooth', 0.05));
    for (let i = 0; i < 24; i++) tone(1500 + Math.random() * 2500, 1.2 + i * 0.05, 0.09, 'sine', 0.05);
  },
  error: () => {
    tone(220, 0, 0.12, 'square', 0.08);
    tone(185, 0.1, 0.2, 'square', 0.08);
  },
};
