// Cash, leveraged positions, fees and liquidation (DESIGN.md section 3). Pure functions:
// every trade returns a new Account. Money is kept in whole cents; quantities are fractional.
//
// One isolated position per stock. 매수 puts up `margin` dollars and opens margin × leverage of stock;
// 인버스 does the same but gains when the price falls. Adding to a stock you hold must use the same direction
// and leverage, and the entry price becomes the average. A position is liquidated once its loss reaches
// (1 − maintenance) of the margin: the player loses the whole margin and never more (cash cannot go negative).
// A 1× 매수 borrows nothing and is never liquidated; an 인버스 loses as the price rises, without limit, so it is
// liquidated at every leverage.
import { CONFIG, type EconomyConfig } from '../config.ts';

export interface Position {
  qty: number;
  entry: number; // average entry price
  margin: number; // dollars put up; always qty × entry / leverage
  leverage: number;
  inverse: boolean; // 인버스: gains when the price falls
}

export interface Account {
  cash: number; // 예탁금 not tied up in positions
  positions: Record<string, Position>;
  trades: number;
  liquidations: number;
  fees: number;
}

export type FillKind = 'buy' | 'sell' | 'liquidation';
export interface Fill {
  kind: FillKind;
  stockId: string;
  inverse: boolean;
  price: number;
  qty: number;
  margin: number; // margin added (buy) or released (sell, liquidation)
  fee: number;
  pnl: number; // realized, after fees (0 for a buy)
  cashDelta: number;
}

export type TradeError = 'amount' | 'cash' | 'leverage' | 'locked' | 'position' | 'price' | 'side';
export type TradeResult = { ok: true; account: Account; fill: Fill } | { ok: false; error: TradeError };

export const TRADE_ERROR_TEXT: Record<TradeError, string> = {
  amount: '주문 금액을 확인하세요',
  cash: '예탁금이 부족합니다',
  leverage: '보유 중인 레버리지로만 추가 매수할 수 있습니다',
  locked: `레버리지는 평가 자산 $${CONFIG.economy.leverageFrom.toLocaleString('en-US')}부터 쓸 수 있습니다`,
  position: '보유 수량이 없습니다',
  price: '가격 오류',
  side: '반대 방향으로 보유 중입니다. 먼저 매도하세요',
};

export const cents = (v: number): number => Math.round(v * 100) / 100;
/** Fees round up to the next cent, so splitting an order never makes it cheaper. */
const feeCents = (v: number): number => Math.ceil(v * 100 - 1e-6) / 100;
const DUST = 1e-9;

export function newAccount(econ: EconomyConfig): Account {
  return { cash: econ.deposit, positions: {}, trades: 0, liquidations: 0, fees: 0 };
}

export const openFee = (margin: number, leverage: number, econ: EconomyConfig): number =>
  feeCents(margin * leverage * econ.feeRate);

/** Largest margin the cash covers at this leverage, fee included. */
export function maxMargin(cash: number, leverage: number, econ: EconomyConfig): number {
  let m = Math.floor((cash / (1 + leverage * econ.feeRate)) * 100) / 100;
  while (m > 0 && m + openFee(m, leverage, econ) > cash) m = cents(m - 0.01);
  return Math.max(0, m);
}

/** Price at which the position is liquidated: below the entry for 매수 (0 for 1×: never), above it for 인버스. */
export function liquidationPrice(pos: Pick<Position, 'entry' | 'leverage' | 'inverse'>, econ: EconomyConfig): number {
  const room = (1 - econ.maintenance) / pos.leverage;
  if (pos.inverse) return pos.entry * (1 + room);
  return pos.leverage > 1 ? pos.entry * (1 - room) : 0;
}

export const unrealized = (pos: Position, price: number): number => (pos.inverse ? -1 : 1) * pos.qty * (price - pos.entry);

/** What the position is worth to the player now (margin plus profit, never below zero). */
export const positionValue = (pos: Position, price: number): number => Math.max(0, pos.margin + unrealized(pos, price));

export function equity(acc: Account, prices: Record<string, number>): number {
  let v = acc.cash;
  for (const [id, pos] of Object.entries(acc.positions)) v += positionValue(pos, prices[id] ?? pos.entry);
  return v;
}

/** A 매수 or 인버스 order. */
export interface BuyOrder {
  stockId: string;
  price: number;
  margin: number;
  leverage: number;
  inverse?: boolean; // 인버스: gains when the price falls
}

export function buy(
  acc: Account,
  { stockId, price, margin, leverage, inverse = false }: BuyOrder,
  econ: EconomyConfig,
  assets = acc.cash, // equity at the current prices; leverage above 1× needs econ.leverageFrom
): TradeResult {
  if (!(price > 0) || !Number.isFinite(price)) return { ok: false, error: 'price' };
  margin = cents(margin);
  if (!Number.isFinite(margin) || margin < econ.minOrder) return { ok: false, error: 'amount' };
  if (!econ.leverages.includes(leverage)) return { ok: false, error: 'leverage' };
  if (leverage > 1 && !(assets >= econ.leverageFrom)) return { ok: false, error: 'locked' };
  const held = acc.positions[stockId];
  if (held && held.inverse !== inverse) return { ok: false, error: 'side' };
  if (held && held.leverage !== leverage) return { ok: false, error: 'leverage' };
  const fee = openFee(margin, leverage, econ);
  if (margin + fee > acc.cash + DUST) return { ok: false, error: 'cash' };

  const qty = (margin * leverage) / price;
  const pos: Position = held
    ? { ...held, qty: held.qty + qty, entry: (held.qty * held.entry + qty * price) / (held.qty + qty), margin: cents(held.margin + margin) }
    : { qty, entry: price, margin, leverage, inverse };
  const cashDelta = -cents(margin + fee);
  return {
    ok: true,
    account: {
      ...acc,
      cash: cents(acc.cash + cashDelta),
      positions: { ...acc.positions, [stockId]: pos },
      trades: acc.trades + 1,
      fees: cents(acc.fees + fee),
    },
    fill: { kind: 'buy', stockId, inverse, price, qty, margin, fee, pnl: 0, cashDelta },
  };
}

/** Sells `fraction` (0..1] of the position at `price`. */
export function sell(acc: Account, stockId: string, price: number, fraction: number, econ: EconomyConfig): TradeResult {
  const pos = acc.positions[stockId];
  if (!pos) return { ok: false, error: 'position' };
  if (!(price > 0) || !Number.isFinite(price)) return { ok: false, error: 'price' };
  if (!(fraction > 0 && fraction <= 1)) return { ok: false, error: 'amount' };

  const all = fraction >= 1 - DUST;
  const qty = all ? pos.qty : pos.qty * fraction;
  const margin = all ? pos.margin : cents(pos.margin * fraction);
  const gross = margin + (pos.inverse ? -1 : 1) * qty * (price - pos.entry);
  const fee = Math.min(Math.max(0, cents(gross)), feeCents(qty * price * econ.feeRate));
  const cashDelta = Math.max(0, cents(gross - fee));
  const positions = { ...acc.positions };
  if (all) delete positions[stockId];
  else positions[stockId] = { ...pos, qty: pos.qty - qty, margin: cents(pos.margin - margin) };
  const pnl = cents(cashDelta - margin);
  return {
    ok: true,
    account: {
      ...acc,
      cash: cents(acc.cash + cashDelta),
      positions,
      trades: acc.trades + 1,
      fees: cents(acc.fees + fee),
    },
    fill: { kind: 'sell', stockId, inverse: pos.inverse, price, qty, margin, fee, pnl, cashDelta },
  };
}

/** Closes every position whose price touched its liquidation price; the margin is lost. */
export function liquidate(acc: Account, prices: Record<string, number>, econ: EconomyConfig): { account: Account; fills: Fill[] } {
  const fills: Fill[] = [];
  let positions = acc.positions;
  for (const [id, pos] of Object.entries(acc.positions)) {
    const price = prices[id];
    const liq = liquidationPrice(pos, econ);
    if (price === undefined || (pos.inverse ? price < liq : price > liq)) continue;
    if (positions === acc.positions) positions = { ...acc.positions };
    delete positions[id];
    fills.push({ kind: 'liquidation', stockId: id, inverse: pos.inverse, price, qty: pos.qty, margin: pos.margin, fee: 0, pnl: -pos.margin, cashDelta: 0 });
  }
  if (fills.length === 0) return { account: acc, fills };
  return { account: { ...acc, positions, liquidations: acc.liquidations + fills.length }, fills };
}

/** Out of the game: nothing held and not enough cash for the smallest order. */
export function isBroke(acc: Account, econ: EconomyConfig): boolean {
  return Object.keys(acc.positions).length === 0 && acc.cash < econ.minOrder + openFee(econ.minOrder, 1, econ);
}
