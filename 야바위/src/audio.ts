// Synthesized sound effects (Web Audio, no audio files). DESIGN.md section 7.
// The AudioContext is created or resumed on the first click or key press (browser autoplay rule).
// Every shuffle move plays the same 'swish' whatever its kind, and every overlap the same 'tak',
// so pass and bounce sound identical.
export type SfxName = 'click' | 'lift' | 'drop' | 'swish' | 'tak' | 'win' | 'lose' | 'clear' | 'tick';
export interface SoundSettings {
  muted: boolean;
  volume: number;
}

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

export class Sfx {
  private ctx: AudioContext | null = null;
  private out: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private ticks: OscillatorNode[] = [];

  constructor(private sound: SoundSettings) {}

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

  set(sound: SoundSettings): void {
    this.sound = { ...sound };
    this.apply();
  }

  /** Plays `name` after `delayMs` (sounds already scheduled follow later mute changes via the master gain). */
  play(name: SfxName, delayMs = 0): void {
    if (!this.ctx || this.sound.muted) return;
    const t = this.ctx.currentTime + Math.max(0, delayMs) / 1000 + 0.005;
    try {
      this.voice(name, t);
    } catch {
      // Ignore a failed voice; sound is decoration.
    }
  }

  /** Stops settlement count ticks that are still scheduled (the screen they belong to is gone). */
  stopTicks(): void {
    for (const osc of this.ticks) {
      try {
        osc.stop();
      } catch {
        // Already stopped.
      }
    }
    this.ticks = [];
  }

  private apply(): void {
    if (!this.ctx || !this.out) return;
    const v = this.sound.muted ? 0 : Math.min(1, Math.max(0, this.sound.volume));
    this.out.gain.setTargetAtTime(v, this.ctx.currentTime, 0.015);
  }

  private voice(name: SfxName, t: number): void {
    switch (name) {
      case 'click':
        return void this.tone(t, 1100, 0.06, { type: 'triangle', gain: 0.18, to: 800 });
      case 'lift':
        this.hiss(t, 0.22, { filter: 'bandpass', freq: 450, to: 1700, q: 0.8, gain: 0.22 });
        return void this.tone(t, 240, 0.2, { gain: 0.07, to: 420 });
      case 'drop':
        this.tone(t, 160, 0.18, { gain: 0.55, to: 55 });
        return this.hiss(t, 0.07, { filter: 'lowpass', freq: 900, gain: 0.3 });
      case 'swish':
        return this.hiss(t, 0.2, { filter: 'bandpass', freq: 700, to: 2600, q: 1.1, gain: 0.34 });
      case 'tak':
        this.tone(t, 900, 0.07, { type: 'triangle', gain: 0.4, to: 520 });
        return this.hiss(t, 0.035, { filter: 'highpass', freq: 2400, gain: 0.35 });
      case 'win':
        return [523.25, 659.25, 783.99, 1046.5].forEach((f, i) =>
          this.tone(t + i * 0.085, f, 0.32, { type: 'triangle', gain: 0.26 }),
        );
      case 'lose':
        this.tone(t, 330, 0.26, { type: 'triangle', gain: 0.3, to: 262 });
        return void this.tone(t + 0.22, 247, 0.45, { type: 'triangle', gain: 0.3, to: 185 });
      case 'clear':
        [523.25, 659.25, 783.99, 1046.5, 1318.5, 1568].forEach((f, i) =>
          this.tone(t + i * 0.07, f, 0.28, { type: 'square', gain: 0.07 }),
        );
        return [523.25, 659.25, 783.99, 1046.5].forEach((f) =>
          this.tone(t + 0.45, f, 0.9, { type: 'triangle', gain: 0.16, attack: 0.02 }),
        );
      case 'tick':
        this.ticks.push(this.tone(t, 2300, 0.035, { type: 'square', gain: 0.06 }));
        return;
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
