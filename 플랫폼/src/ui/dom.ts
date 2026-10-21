// Tiny DOM builder: h('button', { class: 'btn', onclick: fn }, 'text'). Shared by the player app and the admin screen.
type Child = Node | string | number | false | null | undefined;
type AttrValue = string | number | boolean | ((e: Event) => void) | null | undefined;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, AttrValue> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (typeof v === 'function') el.addEventListener(k.replace(/^on/, ''), v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children) if (c != null && c !== false) el.append(typeof c === 'number' ? String(c) : c);
  return el;
}

export function setText(el: Element, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

/** "+3", "0", "−2" (minus sign, not hyphen). */
export const signed = (n: number): string => (n > 0 ? `+${n}` : n < 0 ? `−${-n}` : '0');

export const chips = (n: number): string => `${n.toLocaleString('ko-KR')}칩`;

const z = (n: number): string => String(n).padStart(2, '0');

/** 14:05:09 today, 10/21 14:05 on another day. */
export function clockTime(ms: number, now = Date.now()): string {
  const d = new Date(ms);
  const t = `${z(d.getHours())}:${z(d.getMinutes())}`;
  return new Date(now).toDateString() === d.toDateString() ? `${t}:${z(d.getSeconds())}` : `${d.getMonth() + 1}/${d.getDate()} ${t}`;
}

/** 3시간 05분, 12분 30초, 45초. */
export function duration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  if (hh) return `${hh}시간 ${z(mm)}분`;
  if (mm) return `${mm}분 ${z(s % 60)}초`;
  return `${s}초`;
}

/** "방금", "3분 전", "2시간 전". */
export function ago(ms: number, now = Date.now()): string {
  const s = Math.floor((now - ms) / 1000);
  if (s < 10) return '방금';
  if (s < 60) return `${s}초 전`;
  if (s < 3600) return `${Math.floor(s / 60)}분 전`;
  return `${Math.floor(s / 3600)}시간 전`;
}

/** A random key for a request that may be sent again after a lost answer. */
export const requestKey = (): string =>
  globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
