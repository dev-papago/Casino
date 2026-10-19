// Number formatting. Signs use the minus sign (−), not a hyphen.
const formatters = new Map<number, Intl.NumberFormat>();
const nf = (d: number): Intl.NumberFormat => {
  let f = formatters.get(d);
  if (!f) {
    f = new Intl.NumberFormat('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
    formatters.set(d, f);
  }
  return f;
};

export const num = (v: number, d = 2): string => nf(d).format(v);
export const usd = (v: number, d = 2): string => (v < 0 ? `−$${num(-v, d)}` : `$${num(v, d)}`);
export const signedUsd = (v: number): string => (v > 0.004 ? `+$${num(v)}` : v < -0.004 ? `−$${num(-v)}` : '$0.00');
export const pct = (v: number, d = 2): string =>
  `${v > 0 ? '+' : v < 0 ? '−' : ''}${num(Math.abs(v * 100), d)}%`;
/** Quantity: whole shares as integers, small amounts with more digits. */
export const qty = (v: number): string => num(v, v >= 1000 ? 0 : v >= 10 ? 2 : 4);
/** Korean market colors: rise is red, fall is blue. */
export const tone = (v: number): 'up' | 'down' | 'flat' => (v > 1e-9 ? 'up' : v < -1e-9 ? 'down' : 'flat');
export const clock = (sec: number): string =>
  `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
