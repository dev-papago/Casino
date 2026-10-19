// Synthesized sound effects (Web Audio, no audio files). The AudioContext is created or resumed on the
// first click or key press (browser autoplay rule).
export type SfxName = 'click' | 'start' | 'buy' | 'sell' | 'profit' | 'loss' | 'liquidate' | 'error' | 'end';

interface ToneOpts {
  type?: OscillatorType;
  gain?: number;
  to?: number; // end frequency
  attack?: number;
}
interface HissOpts {
  filter: BiquadFilterType;
  freq: number;
  to?: number;
  q?: number;
  gain?: number;
}

const VOLUME = 0.8;

export class Sfx {
  private ctx: AudioContext | null = null;
  private out: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private muted: boolean;

  constructor(muted: boolean) {
    this.muted = muted;
  }

  get isMuted(): boolean {
    return this.muted;
  }

  unlock(): void {
    try {
      if (!this.ctx) {
        const ctx = new AudioContext();
        this.out = ctx.createGain();
        this.out.connect(ctx.destination);
        this.noise = makeNoise(ctx);
        this.ctx = ctx;
        this.apply();
      }
      if (this.ctx.state === 'suspended') void this.ctx.resume();
    } catch {
      // No audio device: stay silent.
    }
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.apply();
  }

  play(name: SfxName, delayMs = 0): void {
    if (!this.ctx || this.muted) return;
    const t = this.ctx.currentTime + Math.max(0, delayMs) / 1000 + 0.005;
    try {
      this.voice(name, t);
    } catch {
      // Ignore a failed voice; sound is decoration.
    }
  }

  private apply(): void {
    if (!this.ctx || !this.out) return;
    this.out.gain.setTargetAtTime(this.muted ? 0 : VOLUME, this.ctx.currentTime, 0.015);
  }

  private voice(name: SfxName, t: number): void {
    switch (name) {
      case 'click':
        return void this.tone(t, 1100, 0.05, { type: 'triangle', gain: 0.16, to: 800 });
      case 'start':
        return [392, 523.25, 659.25, 783.99, 1046.5].forEach((f, i) =>
          this.tone(t + i * 0.07, f, 0.35, { type: 'square', gain: 0.06 }),
        );
      case 'buy': // cash register: rising blip and a bright ding
        this.tone(t, 660, 0.08, { type: 'square', gain: 0.08, to: 990 });
        this.tone(t + 0.07, 1318.5, 0.35, { type: 'triangle', gain: 0.22 });
        return this.hiss(t, 0.06, { filter: 'highpass', freq: 3000, gain: 0.15 });
      case 'sell':
        this.tone(t, 990, 0.08, { type: 'square', gain: 0.08, to: 660 });
        return void this.tone(t + 0.07, 880, 0.3, { type: 'triangle', gain: 0.2 });
      case 'profit': // coins
        return [1046.5, 1318.5, 1568, 2093].forEach((f, i) =>
          this.tone(t + i * 0.06, f, 0.25, { type: 'triangle', gain: 0.2 }),
        );
      case 'loss':
        this.tone(t, 392, 0.22, { type: 'triangle', gain: 0.26, to: 330 });
        return void this.tone(t + 0.18, 311, 0.4, { type: 'triangle', gain: 0.26, to: 233 });
      case 'liquidate': // alarm sweep twice, then a thud
        for (let i = 0; i < 3; i++) this.tone(t + i * 0.22, 1200, 0.2, { type: 'sawtooth', gain: 0.1, to: 500 });
        this.tone(t + 0.66, 110, 0.6, { gain: 0.5, to: 40 });
        return this.hiss(t + 0.66, 0.4, { filter: 'lowpass', freq: 600, gain: 0.35 });
      case 'error':
        return void this.tone(t, 180, 0.15, { type: 'square', gain: 0.08 });
      case 'end':
        [523.25, 659.25, 783.99].forEach((f, i) => this.tone(t + i * 0.12, f, 0.3, { type: 'triangle', gain: 0.2 }));
        return void this.tone(t + 0.36, 1046.5, 0.8, { type: 'triangle', gain: 0.22, attack: 0.02 });
    }
  }

  private tone(t: number, freq: number, dur: number, o: ToneOpts): OscillatorNode {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = o.type ?? 'sine';
    osc.frequency.setValueAtTime(freq, t);
    if (o.to) osc.frequency.exponentialRampToValueAtTime(o.to, t + dur);
    envelope(g.gain, t, dur, o.gain ?? 0.3, o.attack ?? 0.004);
    osc.connect(g).connect(this.out!);
    osc.start(t);
    osc.stop(t + dur + 0.03);
    return osc;
  }

  private hiss(t: number, dur: number, o: HissOpts): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = o.filter;
    f.frequency.setValueAtTime(o.freq, t);
    if (o.to) f.frequency.exponentialRampToValueAtTime(o.to, t + dur);
    f.Q.value = o.q ?? 0.7;
    const g = ctx.createGain();
    envelope(g.gain, t, dur, o.gain ?? 0.3, dur * 0.3);
    src.connect(f).connect(g).connect(this.out!);
    src.start(t);
    src.stop(t + dur + 0.03);
  }
}

function envelope(p: AudioParam, t: number, dur: number, peak: number, attack: number): void {
  p.setValueAtTime(0.0001, t);
  p.exponentialRampToValueAtTime(peak, t + attack);
  p.exponentialRampToValueAtTime(0.0001, t + dur);
}

/** One second of white noise from a small LCG (the game RNG is not needed for sound). */
function makeNoise(ctx: AudioContext): AudioBuffer {
  const buf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const data = buf.getChannelData(0);
  let s = 12345;
  for (let i = 0; i < data.length; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    data[i] = s / 0x8000_0000 - 1;
  }
  return buf;
}
