// Short synthesized sounds (Web Audio, no files). The first click or key press unlocks audio in the browser.
type Kind = 'click' | 'coin' | 'alert' | 'error' | 'cashout';

let ctx: AudioContext | null = null;

export function unlockAudio(): void {
  try {
    ctx ??= new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume();
  } catch {
    ctx = null;
  }
}

const NOTES: Record<Kind, [number, number, number][]> = {
  // [frequency Hz, start s, length s]
  click: [[880, 0, 0.04]],
  coin: [
    [988, 0, 0.08],
    [1319, 0.07, 0.18],
  ],
  alert: [
    [660, 0, 0.12],
    [880, 0.14, 0.12],
    [660, 0.28, 0.16],
  ],
  error: [
    [220, 0, 0.12],
    [185, 0.1, 0.2],
  ],
  cashout: [
    [784, 0, 0.09],
    [988, 0.08, 0.09],
    [1175, 0.16, 0.09],
    [1568, 0.24, 0.28],
  ],
};

export function play(kind: Kind, volume = 0.18): void {
  if (!ctx || ctx.state !== 'running') return;
  const t0 = ctx.currentTime;
  for (const [f, at, len] of NOTES[kind]) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = kind === 'error' ? 'sawtooth' : 'triangle';
    osc.frequency.value = f;
    gain.gain.setValueAtTime(0, t0 + at);
    gain.gain.linearRampToValueAtTime(volume, t0 + at + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + at + len);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t0 + at);
    osc.stop(t0 + at + len + 0.02);
  }
}
