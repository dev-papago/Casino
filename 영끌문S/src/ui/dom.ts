// Tiny DOM builder: h('button', { class: 'btn', onclick: fn }, 'text').
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

/** Element from a trusted static markup string (inline SVG art). */
export function fromHtml(markup: string): Element {
  const t = document.createElement('template');
  t.innerHTML = markup.trim();
  return t.content.firstElementChild as Element;
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, Math.max(0, ms)));

export interface ButtonOpts {
  kind?: 'primary' | 'ghost' | 'danger';
  key?: string; // keyboard hint shown inside the button
  testid?: string;
}

export function button(label: string, onClick: () => void, o: ButtonOpts = {}): HTMLButtonElement {
  const b = h(
    'button',
    { class: `btn ${o.kind ?? ''}`.trim(), type: 'button', 'data-testid': o.testid },
    h('span', {}, label),
    o.key ? h('kbd', {}, o.key) : null,
  );
  b.addEventListener('click', onClick);
  return b;
}

/** "+3", "0", "−2" (minus sign, not hyphen). */
export const signed = (n: number): string => (n > 0 ? `+${n}` : n < 0 ? `−${-n}` : '0');
