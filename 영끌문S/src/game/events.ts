// 급등·급락 (DESIGN.md section 2). Time is cut into windows of timing.eventWindowSec (2 minutes) from the start of
// the market; each window gets at most one event, at a random moment inside it, with probability `chance`. So an
// event at 1:50 can be followed by another one just after 2:00. An event may start with a small move the other
// way (the bait), then makes its move, then may give part of it back.
import type { EventDef, Range } from '../config.ts';
import { between, type Rng } from '../rng.ts';

interface Leg {
  from: number; // tick, inclusive
  to: number; // tick, exclusive
  perTick: number;
}

/** Per-tick log-price changes of one stock's events. */
export function makeEvents(def: EventDef, rng: Rng, dt: number, windowSec: number): () => number {
  const window = Math.max(1, Math.round(windowSec / dt));
  const ticks = (r: Range): number => Math.max(1, Math.round(between(rng, r) / dt));
  const legs: Leg[] = [];
  let t = 0;
  let fireAt = -1;

  const start = (): void => {
    const move = rng.float() < def.up ? between(rng, def.gain) : -between(rng, def.drop);
    let from = t;
    const lead = between(rng, def.lead);
    if (lead > 0) {
      const n = ticks(def.leadSec);
      legs.push({ from, to: from + n, perTick: (-Math.sign(move) * lead) / n });
      from += n;
    }
    const n = ticks(def.sec);
    legs.push({ from, to: from + n, perTick: move / n });
    const back = between(rng, def.giveBack);
    if (back > 0) {
      const m = ticks(def.giveBackSec);
      legs.push({ from: from + n, to: from + n + m, perTick: (-move * back) / m });
    }
  };

  return () => {
    if (t % window === 0) fireAt = def.chance > 0 && rng.float() < def.chance ? t + rng.int(window) : -1;
    if (t === fireAt) start();
    let d = 0;
    for (let k = legs.length - 1; k >= 0; k--) {
      const leg = legs[k];
      if (t >= leg.to) legs.splice(k, 1);
      else if (t >= leg.from) d += leg.perTick * (0.4 + 1.2 * rng.float()); // jagged, same total on average
    }
    t++;
    return d;
  };
}
