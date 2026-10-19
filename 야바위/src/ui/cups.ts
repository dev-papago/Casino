// rAF renderer. Cup and shadow positions come only from cupPoses(plan, t); z-index is pose.z.
// The ball is in the DOM only while it is shown before a shuffle or revealed after a pick, and is
// always drawn under the pose of the cup that holds it (cup `plan.start`).
import type { TimingConfig } from '../config';
import { SLOT_X, Y_RANGE, cupPoses, type CupId, type Plan, type Pose, type Slot } from '../game/shuffle';
import { BALL_SVG, CUP_SVG } from './art';
import { fromHtml, h } from './dom';

const DEPTH = 0.5; // screen offset per unit of y, in slot spacings (y > 0 = toward the player = lower)
const DEPTH_SCALE = 0.12; // cups nearer the player look slightly bigger
const LIFT = 0.55; // lift height, in cup heights (must match .cup.up in style.css)
const CUP_IDS: readonly CupId[] = [0, 1, 2];

/** No moves: every cup at rest in its own slot. */
export const REST_PLAN: Plan = { level: 'easy', start: 0, moves: [], final: 0, ceiling: 1, totalMs: 0 };

export class CupsView {
  readonly el: HTMLElement;
  private readonly cups: HTMLElement[] = [];
  private readonly shadows: HTMLElement[] = [];
  private readonly zones: HTMLButtonElement[] = [];
  private ball: HTMLElement | null = null;
  private ballCup: CupId | null = null;
  private poses: Pose[];
  private geo = { cx: 0, base: 0, s: 1, cupH: 1 };
  private raf = 0;
  private ballTimer = 0;
  private finish: ((done: boolean) => void) | null = null;

  constructor(
    private readonly timing: TimingConfig,
    onPick: (slot: Slot) => void,
  ) {
    this.el = h('div', { class: 'stage', 'data-testid': 'stage' });
    for (const c of CUP_IDS) {
      const shadow = h('div', { class: 'shadow' });
      const cup = h('div', { class: 'cup' }, h('div', { class: 'cup-body' }, fromHtml(CUP_SVG)));
      this.shadows[c] = shadow;
      this.cups[c] = cup;
      this.el.append(shadow, cup);
    }
    SLOT_X.forEach((_, i) => {
      const zone = h(
        'button',
        { class: 'zone', type: 'button', disabled: true, 'aria-label': `${i + 1}번 컵`, 'data-slot': i },
        h('span', { class: 'key' }, String(i + 1)),
      );
      zone.addEventListener('click', () => onPick(i as Slot));
      this.zones.push(zone);
      this.el.append(zone);
    });
    this.poses = cupPoses(REST_PLAN, 0, timing);
    new ResizeObserver(() => this.layout()).observe(this.el);
  }

  /** Draws the plan at time tMs without animating. */
  show(plan: Plan, tMs: number): void {
    this.stop();
    this.draw(cupPoses(plan, tMs, this.timing));
  }

  /** Animates the whole plan on one rAF clock; resolves false if stopped early. */
  play(plan: Plan, rate: number): Promise<boolean> {
    this.stop();
    return new Promise((resolve) => {
      this.finish = resolve;
      let t0 = -1;
      const frame = (now: number): void => {
        if (t0 < 0) t0 = now;
        const t = Math.min(plan.totalMs, (now - t0) * rate);
        this.draw(cupPoses(plan, t, this.timing));
        if (t < plan.totalMs) {
          this.raf = requestAnimationFrame(frame);
          return;
        }
        this.raf = 0;
        this.finish = null;
        resolve(true);
      };
      this.raf = requestAnimationFrame(frame);
    });
  }

  stop(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    const f = this.finish;
    this.finish = null;
    f?.(false);
  }

  /** Back to the resting state: no animation, no ball, all cups down. */
  reset(): void {
    this.stop();
    this.removeBall();
    this.lift(CUP_IDS, false, 0);
    for (const c of CUP_IDS) this.cups[c].classList.remove('shake');
    this.draw(cupPoses(REST_PLAN, 0, this.timing));
  }

  /** Cup currently resting at `slot` (read from the drawn poses). */
  cupAt(slot: Slot): CupId {
    const p = this.poses.find((q) => Math.abs(q.x - SLOT_X[slot]) < 1e-6 && Math.abs(q.y) < 1e-6);
    if (!p) throw new Error(`no cup at rest in slot ${slot}`);
    return p.cup;
  }

  lift(cups: readonly CupId[], up: boolean, ms: number): void {
    for (const c of cups) {
      for (const el of [this.cups[c], this.shadows[c]]) {
        el.style.setProperty('--lift-ms', `${Math.round(ms)}ms`);
        el.classList.toggle('up', up);
      }
    }
  }

  /** Lowers every cup; the ball leaves the DOM once they are down. */
  lowerAll(ms: number): void {
    this.lift(CUP_IDS, false, ms);
    for (const c of CUP_IDS) this.cups[c].classList.remove('shake');
    clearTimeout(this.ballTimer);
    this.ballTimer = window.setTimeout(() => this.removeBall(), ms);
  }

  shake(cup: CupId, ms: number): void {
    const el = this.cups[cup];
    el.style.setProperty('--shake-ms', `${Math.round(ms)}ms`);
    el.classList.remove('shake');
    void el.offsetWidth; // restart the animation
    el.classList.add('shake');
  }

  putBall(cup: CupId): void {
    this.removeBall();
    this.ball = h('div', { class: 'ball', 'data-testid': 'ball' }, fromHtml(BALL_SVG));
    this.ballCup = cup;
    this.el.append(this.ball);
    this.draw(this.poses);
  }

  removeBall(): void {
    clearTimeout(this.ballTimer);
    this.ball?.remove();
    this.ball = null;
    this.ballCup = null;
  }

  ballRect(): DOMRect | null {
    return this.ball?.getBoundingClientRect() ?? null;
  }

  setPickable(on: boolean): void {
    for (const z of this.zones) z.disabled = !on;
  }

  private layout(): void {
    const w = this.el.clientWidth;
    const hgt = this.el.clientHeight;
    if (!w || !hgt) return;
    const s = Math.min(w * 0.3, hgt * 0.64);
    const cupW = s * 0.6;
    const cupH = cupW * 1.1;
    const above = cupH * (1 + LIFT); // a lifted cup is higher than any cup on a back arc
    const below = s * DEPTH * Y_RANGE[1] + cupW * 0.18; // the nearest point of an arc, plus its shadow
    const base = Math.round((hgt - above - below) / 2 + above);
    this.geo = { cx: w / 2, base, s, cupH };
    this.el.style.setProperty('--cup-w', `${cupW.toFixed(1)}px`);
    this.el.style.setProperty('--cup-h', `${cupH.toFixed(1)}px`);
    const zoneW = s * 0.9;
    const zoneTop = base - cupH * 1.12;
    const zoneH = cupH * 1.12 + s * 0.32;
    this.zones.forEach((z, i) => {
      z.style.left = `${(w / 2 + SLOT_X[i] * s - zoneW / 2).toFixed(1)}px`;
      z.style.top = `${zoneTop.toFixed(1)}px`;
      z.style.width = `${zoneW.toFixed(1)}px`;
      z.style.height = `${zoneH.toFixed(1)}px`;
    });
    this.draw(this.poses);
  }

  private draw(poses: Pose[]): void {
    this.poses = poses;
    const { cx, base, s, cupH } = this.geo;
    for (const p of poses) {
      const px = (cx + p.x * s).toFixed(2);
      const py = (base + p.y * DEPTH * s).toFixed(2);
      const k = (1 + p.y * DEPTH_SCALE).toFixed(4);
      const cup = this.cups[p.cup];
      cup.style.transform = `translate(${px}px, ${py}px) translate(-50%, -100%) scale(${k})`;
      // Stacking from pose.z only: shadows 1..3, ball 4 (style.css), cups 5..7.
      cup.style.zIndex = String(5 + p.z);
      const shadow = this.shadows[p.cup];
      shadow.style.transform = `translate(${px}px, ${py}px) translate(-50%, -50%) scale(${k})`;
      shadow.style.zIndex = String(1 + p.z);
    }
    if (this.ball && this.ballCup != null) {
      const p = poses[this.ballCup];
      const k = 1 + p.y * DEPTH_SCALE;
      const py = base + p.y * DEPTH * s - cupH * 0.06; // fully inside the cup's outline when it is down
      this.ball.style.transform = `translate(${(cx + p.x * s).toFixed(2)}px, ${py.toFixed(2)}px) translate(-50%, -100%) scale(${k.toFixed(4)})`;
    }
  }
}
