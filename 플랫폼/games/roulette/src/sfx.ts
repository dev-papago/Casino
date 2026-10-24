// 러시안 룰렛's sounds, synthesized like the other arcade games (games/arcade/sound.ts): no files.
import { hiss, sfx as arcade, tone } from '../../arcade/sound.ts';

export const sfx = {
  click: arcade.click,
  error: arcade.error,
  /** The duel begins: a low gong. */
  start: () => {
    tone(98, 0, 1.6, 'sine', 0.35, 92);
    tone(147, 0, 1.4, 'sine', 0.14, 140);
    tone(196, 0.02, 1.0, 'triangle', 0.05);
    hiss(0, 0.25, 300, 0.25, 0.7);
  },
  /** One round dropping into the cylinder: a brass clink, a little higher each time. */
  shell: (i: number) => {
    tone(2300 + i * 140, 0, 0.07, 'triangle', 0.09);
    tone(3400 + i * 90, 0.01, 0.05, 'sine', 0.05);
    hiss(0, 0.03, 6500, 0.12, 5);
  },
  /** The cylinder spun: ratchet clicks slowing down, then the latch. */
  spin: (len = 1.4) => {
    let t = 0;
    let gap = 0.03;
    while (t < len) {
      hiss(t, 0.014, 3600 + Math.random() * 600, 0.22, 10);
      t += gap;
      gap *= 1.11;
    }
    hiss(t + 0.02, 0.04, 1800, 0.5, 6);
    tone(900, t + 0.02, 0.05, 'square', 0.06);
  },
  /** The hammer pulled back. */
  cock: () => {
    hiss(0, 0.02, 3200, 0.45, 10);
    hiss(0.11, 0.035, 2100, 0.6, 7);
    tone(1150, 0.11, 0.03, 'square', 0.06);
  },
  /** A live round: crack, blast, and a low boom that rolls on. */
  bang: () => {
    hiss(0, 0.06, 5200, 1.0, 0.8);
    hiss(0, 0.55, 800, 1.0, 0.35);
    hiss(0.04, 0.9, 260, 0.6, 0.5);
    tone(95, 0, 0.7, 'sine', 0.7, 32);
    tone(60, 0.02, 1.1, 'triangle', 0.35, 26);
  },
  /** A blank: the dry snap of the hammer on nothing. */
  dry: () => {
    hiss(0, 0.022, 4300, 0.55, 9);
    tone(2600, 0, 0.022, 'square', 0.07);
    hiss(0.06, 0.03, 1500, 0.2, 6);
  },
  /** Losing a life: a falling, broken tone. */
  hurt: () => {
    tone(240, 0.05, 0.35, 'sawtooth', 0.08, 80);
    tone(180, 0.12, 0.45, 'square', 0.04, 60);
  },
  /** A heartbeat (the last seconds of a turn, the moment before a shot). */
  heart: (vol = 0.5) => {
    tone(58, 0, 0.13, 'sine', vol, 44);
    tone(52, 0.19, 0.15, 'sine', vol * 0.8, 40);
  },
  tick: () => hiss(0, 0.02, 3000, 0.09, 5),
  /** The coin thrown: a ping, the spin's flutter, the landing ring. */
  coin: (len = 2.2) => {
    tone(1600, 0, 0.09, 'sine', 0.12);
    for (let t = 0.1; t < len - 0.3; t += 0.09) hiss(t, 0.03, 5200 - t * 900, 0.05, 6);
    tone(2200, len, 0.25, 'sine', 0.13);
    tone(3100, len + 0.03, 0.3, 'sine', 0.07);
    tone(1500, len + 0.12, 0.2, 'sine', 0.06);
  },
  /** A new round. */
  round: () => {
    [0, 0.16, 0.32].forEach((t) => hiss(t, 0.18, 140, 0.6, 1));
    tone(73, 0.32, 0.6, 'sine', 0.3, 60);
  },
  /** My turn. */
  turn: () => {
    tone(523, 0, 0.12, 'triangle', 0.1);
    tone(784, 0.1, 0.18, 'triangle', 0.1);
  },
  win: arcade.bigWin,
  lose: () => {
    tone(196, 0, 0.5, 'sawtooth', 0.08, 147);
    tone(147, 0.4, 0.8, 'sawtooth', 0.08, 98);
    tone(73, 0.4, 1.4, 'sine', 0.25, 55);
  },
};
