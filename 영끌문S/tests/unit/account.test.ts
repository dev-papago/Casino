import { describe, expect, it } from 'vitest';
import { CONFIG } from '../../src/config.ts';
import {
  buy,
  equity,
  isBroke,
  liquidate,
  liquidationPrice,
  maxMargin,
  newAccount,
  openFee,
  sell,
  type Account,
  type TradeResult,
} from '../../src/game/account.ts';

// Leverage unlocks at econ.leverageFrom; most tests use it from the first trade.
const econ = { ...CONFIG.economy, leverageFrom: 0 };
const ok = (r: TradeResult): Account => {
  if (!r.ok) throw new Error(`trade failed: ${r.error}`);
  return r.account;
};

describe('account', () => {
  it('starts with the base deposit and nothing held', () => {
    const a = newAccount(econ);
    expect(a.cash).toBe(1000);
    expect(a.positions).toEqual({});
  });

  it('buy takes margin plus fee and opens margin × leverage of stock', () => {
    const a = ok(buy(newAccount(econ), 'kingka', 50, 100, 10, econ));
    const pos = a.positions.kingka;
    expect(a.cash).toBe(1000 - 100 - 1); // fee 0.1% of $1,000
    expect(pos.qty).toBeCloseTo(20); // $1,000 / $50
    expect(pos.margin).toBe(100);
    expect(liquidationPrice(pos, econ)).toBeCloseTo(50 * (1 - 0.95 / 10));
  });

  it('rejects bad orders', () => {
    const a = newAccount(econ);
    expect(buy(a, 'kingka', 50, 5, 1, econ)).toEqual({ ok: false, error: 'amount' });
    expect(buy(a, 'kingka', 50, Number.NaN, 1, econ)).toEqual({ ok: false, error: 'amount' });
    expect(buy(a, 'kingka', 50, 1000, 1, econ)).toEqual({ ok: false, error: 'cash' }); // no room for the fee
    expect(buy(a, 'kingka', 50, 100, 7, econ)).toEqual({ ok: false, error: 'leverage' });
    const held = ok(buy(a, 'kingka', 50, 100, 5, econ));
    expect(buy(held, 'kingka', 50, 100, 10, econ)).toEqual({ ok: false, error: 'leverage' });
    expect(sell(a, 'kingka', 50, 1, econ)).toEqual({ ok: false, error: 'position' });
  });

  it('leverage above 1× needs the equity to reach leverageFrom', () => {
    const real = CONFIG.economy;
    const a = newAccount(real);
    expect(buy(a, 'kingka', 50, 100, 5, real)).toEqual({ ok: false, error: 'locked' }); // defaults to cash
    expect(buy(a, 'kingka', 50, 100, 5, real, real.leverageFrom - 0.01)).toEqual({ ok: false, error: 'locked' });
    expect(buy(a, 'kingka', 50, 100, 5, real, real.leverageFrom).ok).toBe(true);
    expect(buy(a, 'kingka', 50, 100, 1, real, 0).ok).toBe(true); // 1× is always open
  });

  it('adding to a position averages the entry and keeps margin = qty × entry / leverage', () => {
    let a = ok(buy(newAccount(econ), 'lownix', 100, 100, 5, econ));
    a = ok(buy(a, 'lownix', 120, 200, 5, econ));
    const pos = a.positions.lownix;
    expect(pos.qty).toBeCloseTo(5 + 1000 / 120);
    expect(pos.margin).toBe(300);
    expect((pos.qty * pos.entry) / pos.leverage).toBeCloseTo(pos.margin);
  });

  it('selling returns margin plus profit minus fee', () => {
    const a = ok(buy(newAccount(econ), 'kingka', 50, 100, 10, econ));
    const up = sell(a, 'kingka', 55, 1, econ);
    if (!up.ok) throw new Error();
    // 20 shares × $5 = +$100; fee 0.1% of $1,100 = $1.10
    expect(up.fill.cashDelta).toBeCloseTo(198.9);
    expect(up.account.positions.kingka).toBeUndefined();
    expect(up.account.cash).toBeCloseTo(899 + 198.9);

    const half = ok(sell(a, 'kingka', 50, 0.5, econ));
    expect(half.positions.kingka.qty).toBeCloseTo(10);
    expect(half.positions.kingka.margin).toBe(50);
  });

  it('liquidates at the liquidation price and loses exactly the margin', () => {
    const a = ok(buy(newAccount(econ), 'gamestop', 10, 100, 20, econ));
    const liq = liquidationPrice(a.positions.gamestop, econ);
    expect(liquidate(a, { gamestop: liq + 0.01 }, econ).fills).toHaveLength(0);
    const r = liquidate(a, { gamestop: liq * 0.5 }, econ);
    expect(r.fills).toHaveLength(1);
    expect(r.account.positions).toEqual({});
    expect(r.account.cash).toBe(a.cash);
    expect(r.account.liquidations).toBe(1);
  });

  it('never pays out below zero, even after a gap through the liquidation price', () => {
    const a = ok(buy(newAccount(econ), 'gamestop', 10, 100, 20, econ));
    const r = sell(a, 'gamestop', 1, 1, econ);
    if (!r.ok) throw new Error();
    expect(r.fill.cashDelta).toBe(0);
    expect(equity(a, { gamestop: 1 })).toBe(a.cash);
  });

  it('the max button always fits the cash, fee included', () => {
    for (const cash of [1000, 999.99, 123.45, 10.02]) {
      for (const L of econ.leverages) {
        const m = maxMargin(cash, L, econ);
        expect(m + openFee(m, L, econ)).toBeLessThanOrEqual(cash);
        if (m >= econ.minOrder) expect(buy({ ...newAccount(econ), cash }, 'kingka', 64, m, L, econ).ok).toBe(true);
      }
    }
  });

  it('fees round up, so splitting a sale never saves money', () => {
    expect(openFee(10, 1, econ)).toBe(0.01);
    expect(openFee(1, 1, econ)).toBe(0.01);
  });

  it('is broke with no position and less than the smallest order', () => {
    expect(isBroke({ ...newAccount(econ), cash: 9.99 }, econ)).toBe(true);
    expect(isBroke({ ...newAccount(econ), cash: 50 }, econ)).toBe(false);
    const held = ok(buy({ ...newAccount(econ), cash: 20 }, 'kingka', 64, 15, 1, econ));
    expect(isBroke(held, econ)).toBe(false);
  });
});
