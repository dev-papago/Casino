// 급등·급락 (DESIGN.md section 2). Time is cut into windows of timing.eventWindowSec (2 minutes) from the start of
// the market; each window gets at most one event, at a random moment inside it, with probability `chance`. So an
// event at 1:50 can be followed by another one just after 2:00. An event is over in a few tenths of a second,
// before anyone can trade on it, and nothing predictable follows it.
//
// The events are paid for: until a window's event has happened, the price drifts the other way by exactly the
// event's expected effect (a stock that can crash creeps up, one that can spike slides down). So the expected
// price never moves, whether or not this window's event has come yet: no timing of the 2-minute rule pays.
import type { EventDef, Range } from '../config.ts';
import { between, meanExp, type Rng } from '../rng.ts';

/** Per-tick log-price changes of one stock's events, including their drift. */
export function makeEvents(def: EventDef, rng: Rng, dt: number, windowSec: number): () => number {
  const window = Math.max(1, Math.round(windowSec / dt));
  const ticks = (r: Range): number => Math.max(1, Math.round(between(rng, r) / dt));
  // E[e^move] − 1: what one event does to the expected price.
  const effect = def.chance > 0 ? def.up * meanExp(def.gain) + (1 - def.up) * meanExp([-def.drop[1], -def.drop[0]]) - 1 : 0;
  let steps: number[] = [];
  let t = 0;
  let fireAt = -1;
  let fired = false;

  const start = (): void => {
    const move = rng.float() < def.up ? between(rng, def.gain) : -between(rng, def.drop);
    const w = Array.from({ length: ticks(def.sec) }, () => 0.4 + 1.2 * rng.float()); // jagged, same total
    const sum = w.reduce((s, x) => s + x, 0);
    steps = w.map((x) => (move * x) / sum);
  };

  return () => {
    const k = t % window;
    if (k === 0) {
      fireAt = def.chance > 0 && rng.float() < def.chance ? t + rng.int(window) : -1;
      fired = false;
    }
    let d = 0;
    if (!fired) {
      const hazard = def.chance / window / (1 - (def.chance * k) / window); // P(this tick | not yet this window)
      d -= Math.log1p(hazard * effect);
    }
    if (t === fireAt) {
      fired = true;
      start();
    }
    if (steps.length) d += steps.shift()!;
    t++;
    return d;
  };
}
