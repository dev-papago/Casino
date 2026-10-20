// Candle chart on a canvas: price bars only, no indicators. Each candle is timing.ticksPerCandle ticks of quotes
// (3 seconds); the last one is still forming. The mouse wheel zooms: fewer, wider candles or more, thinner ones.
// The price range eases toward the visible candles so the chart does not jump. A low-volume stock gets a wider
// range around them (volume.chartPad), so its candles look short and a busy stock's look long.
// Extra horizontal lines mark the player's average entry and liquidation price.
import type { Range } from '../config.ts';
import type { Candle, Stock } from '../game/market.ts';
import { num } from './format.ts';

export interface ChartLine {
  price: number;
  label: string;
  color: string;
}

const UP = '#ff4560';
const DOWN = '#3d8bff';
const GRID = 'rgba(140, 170, 255, 0.08)';
const AXIS_TEXT = 'rgba(200, 215, 255, 0.6)';
const FONT = "'Malgun Gothic', 'Apple SD Gothic Neo', 'Noto Sans KR', sans-serif";
const ZOOM_PER_DELTA = 0.0015; // one wheel notch (deltaY ≈ 100) changes the candle count by about 16%

export class CandleChart {
  readonly el: HTMLDivElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private visible: number;
  private readonly candleSec: number;
  private lo = Number.NaN;
  private hi = Number.NaN;
  private plot = { x: 0, y: 0, w: 0, h: 0 };
  private last = { x: 0, y: 0 };

  constructor(visible: number, zoom: Range, candleSec: number) {
    this.visible = visible;
    this.candleSec = candleSec;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'chart-canvas';
    this.ctx = this.canvas.getContext('2d')!;
    this.el = document.createElement('div');
    this.el.className = 'chart';
    this.el.dataset.candles = String(visible);
    this.el.append(this.canvas);
    this.el.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault(); // no page scroll, no browser zoom
        const delta = clamp(e.deltaY, -200, 200);
        this.visible = Math.round(clamp(this.visible * Math.exp(delta * ZOOM_PER_DELTA), zoom[0], zoom[1]));
        this.el.dataset.candles = String(this.visible);
      },
      { passive: false },
    );
  }

  /** Snap the price range on the next draw (another stock was selected or a new game started). */
  reset(): void {
    this.lo = this.hi = Number.NaN;
  }

  /** Where the newest price sits, in CSS pixels relative to the chart box. */
  lastPoint(): { x: number; y: number } {
    return { ...this.last };
  }

  draw(stock: Stock, lines: readonly ChartLine[]): void {
    const { canvas, ctx } = this;
    const dpr = window.devicePixelRatio || 1;
    const w = this.el.clientWidth;
    const h = this.el.clientHeight;
    if (w === 0 || h === 0) return;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    const axisW = rem * 5.6;
    const pad = rem * 0.8;
    this.plot = { x: pad * 0.5, y: pad, w: w - axisW - pad * 0.5, h: h - pad * 2 };
    const P = this.plot;

    const candles: Candle[] = [...stock.candles.slice(-(this.visible - 1)), stock.live];
    this.ease(candles, stock.def.volume.chartPad);
    const span = this.hi - this.lo;
    const yOf = (p: number): number => P.y + (1 - (p - this.lo) / span) * P.h;
    const d = stock.def.decimals;

    // Ticker watermark
    ctx.save();
    ctx.font = `900 ${rem * 6}px ${FONT}`;
    ctx.fillStyle = 'rgba(120, 150, 255, 0.045)';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(stock.def.ticker, P.x + P.w / 2, P.y + P.h / 2);
    ctx.font = `600 ${rem * 0.7}px ${FONT}`;
    ctx.fillStyle = AXIS_TEXT;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillText(`봉 ${this.candleSec}초 · ${this.visible}개 · 마우스 휠로 확대/축소`, P.x + rem * 0.3, h - rem * 0.25);
    ctx.restore();

    // Price grid and axis labels
    const step = niceStep(span / 6);
    ctx.font = `600 ${rem * 0.78}px ${FONT}`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    for (let p = Math.ceil(this.lo / step) * step; p <= this.hi; p += step) {
      const y = Math.round(yOf(p)) + 0.5;
      ctx.strokeStyle = GRID;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(P.x, y);
      ctx.lineTo(P.x + P.w, y);
      ctx.stroke();
      ctx.fillStyle = AXIS_TEXT;
      ctx.fillText(num(p, axisDecimals(step, d)), P.x + P.w + rem * 0.5, y);
    }

    // Candles
    const slot = P.w / this.visible;
    const body = Math.max(1, slot * 0.66);
    ctx.save();
    ctx.beginPath();
    ctx.rect(P.x, 0, P.w, h);
    ctx.clip();
    candles.forEach((c, i) => {
      // A game starts with only the live candle: candles fill in from the left edge, then scroll.
      const cx = P.x + (i + 0.5) * slot;
      const color = c.c >= c.o ? UP : DOWN;
      const yo = yOf(c.o);
      const yc = yOf(c.c);
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = Math.max(1, slot * 0.1);
      ctx.beginPath();
      ctx.moveTo(cx, yOf(c.h));
      ctx.lineTo(cx, yOf(c.l));
      ctx.stroke();
      const live = i === candles.length - 1;
      if (live) {
        ctx.shadowColor = color;
        ctx.shadowBlur = rem * 0.8;
      }
      ctx.fillRect(cx - body / 2, Math.min(yo, yc), body, Math.max(1, Math.abs(yc - yo)));
      ctx.shadowBlur = 0;
    });
    ctx.restore();

    // Position lines, then the last price on top
    for (const line of lines) this.hline(line.price, line.color, line.label, d, rem, yOf, true);
    const live = stock.live;
    const lastColor = live.c >= live.o ? UP : DOWN;
    this.hline(stock.price, lastColor, '', d, rem, yOf, false);
    this.last = { x: P.x + (candles.length - 0.5) * slot, y: clamp(yOf(stock.price), P.y, P.y + P.h) };
  }

  private ease(candles: readonly Candle[], chartPad: number): void {
    let lo = Infinity;
    let hi = -Infinity;
    for (const c of candles) {
      if (c.l < lo) lo = c.l;
      if (c.h > hi) hi = c.h;
    }
    const mid = (lo + hi) / 2;
    const half = Math.max((hi - lo) / 2, mid * 0.004) * chartPad;
    const tLo = mid - half;
    const tHi = mid + half;
    if (Number.isNaN(this.lo)) {
      this.lo = tLo;
      this.hi = tHi;
      return;
    }
    // Widen fast so new extremes stay on screen, narrow slowly.
    this.lo += (tLo - this.lo) * (tLo < this.lo ? 0.4 : 0.08);
    this.hi += (tHi - this.hi) * (tHi > this.hi ? 0.4 : 0.08);
  }

  /** A dashed line across the plot with a price tag on the axis; off-range lines stick to the edge. */
  private hline(
    price: number,
    color: string,
    label: string,
    d: number,
    rem: number,
    yOf: (p: number) => number,
    dashed: boolean,
  ): void {
    const { ctx, plot: P } = this;
    const raw = yOf(price);
    const inside = raw >= P.y && raw <= P.y + P.h;
    const y = Math.round(clamp(raw, P.y, P.y + P.h)) + 0.5;
    ctx.save();
    ctx.globalAlpha = inside ? 1 : 0.55;
    if (inside) {
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.setLineDash(dashed ? [6, 4] : [2, 3]);
      ctx.beginPath();
      ctx.moveTo(P.x, y);
      ctx.lineTo(P.x + P.w, y);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.font = `700 ${rem * 0.78}px ${FONT}`;
    ctx.textBaseline = 'middle';
    const tag = num(price, d);
    const tw = ctx.measureText(tag).width + rem * 0.7;
    const th = rem * 1.3;
    ctx.fillStyle = color;
    ctx.fillRect(P.x + P.w + 1, y - th / 2, tw, th);
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'left';
    ctx.fillText(tag, P.x + P.w + 1 + rem * 0.35, y);
    if (label) {
      const text = inside ? label : `${label} ${raw < P.y ? '▲' : '▼'}`;
      const lw = ctx.measureText(text).width + rem * 0.7;
      const ly = clamp(y - th / 2, P.y, P.y + P.h - th);
      ctx.fillStyle = 'rgba(7, 11, 22, 0.85)';
      ctx.fillRect(P.x + rem * 0.3, ly, lw, th);
      ctx.strokeStyle = color;
      ctx.strokeRect(P.x + rem * 0.3 + 0.5, ly + 0.5, lw - 1, th - 1);
      ctx.fillStyle = color;
      ctx.fillText(text, P.x + rem * 0.65, ly + th / 2);
    }
    ctx.restore();
  }
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** 1, 2 or 5 × a power of ten, at least `raw`. */
function niceStep(raw: number): number {
  const p = 10 ** Math.floor(Math.log10(raw));
  const m = raw / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p;
}

const axisDecimals = (step: number, d: number): number => Math.min(d, Math.max(0, -Math.floor(Math.log10(step))));
