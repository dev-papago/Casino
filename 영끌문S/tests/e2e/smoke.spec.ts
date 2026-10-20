// One full game: start, pick a stock, buy, sell, 인버스, settle, back to the title.
import { expect, test } from '@playwright/test';

test('a game from the title screen to the settlement', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('/');
  const app = page.locator('#app');
  await expect(app).toHaveAttribute('data-screen', 'title');

  await page.getByTestId('start').click();
  await expect(app).toHaveAttribute('data-screen', 'trade');
  await expect(page.getByTestId('cash')).toHaveText('$1,000.00');

  // Tabs run from the easiest stock to the hardest; there is no close, the clock shows the time played.
  const order = await page.locator('.tab').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')));
  expect(order).toEqual(['tab-kingka', 'tab-lownix', 'tab-dolge', 'tab-mwodna', 'tab-gamestop']);
  await expect(page.getByTestId('clock')).toHaveText(/^00:\d\d$/);

  // Leverage stays locked until the equity reaches econ.leverageFrom ($2,000).
  await expect(page.getByTestId('lev-5')).toBeDisabled();
  await expect(page.getByTestId('lev-lock')).toBeVisible();

  // Hold and drag on the chart: right makes the candles wider (fewer on screen), up makes them taller.
  // Left and down do the opposite, and a double click restores the default size.
  const chart = page.locator('.chart');
  await expect(chart).toHaveAttribute('data-candles', '100');
  await expect(chart).toHaveAttribute('data-stretch', '1.00');
  const box = (await chart.boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const drag = async (dx: number, dy: number): Promise<void> => {
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + dx, cy + dy, { steps: 5 });
    await page.mouse.up();
  };
  const candles = async (): Promise<number> => Number(await chart.getAttribute('data-candles'));
  const stretch = async (): Promise<number> => Number(await chart.getAttribute('data-stretch'));
  await drag(120, -80);
  expect(await candles()).toBeLessThan(100);
  expect(await stretch()).toBeGreaterThan(1);
  await chart.dblclick({ position: { x: box.width / 2, y: box.height / 2 } });
  await expect(chart).toHaveAttribute('data-candles', '100');
  await expect(chart).toHaveAttribute('data-stretch', '1.00');
  await drag(-120, 80);
  expect(await candles()).toBeGreaterThan(100);
  expect(await stretch()).toBeLessThan(1);

  // 킹카콜라 trades little: it fills at once, at the shown price. $100 at 1× pays a $0.10 fee.
  // The detail panel no longer lists the quote rate, the fill delay or a leverage limit.
  await expect(page.getByTestId('detail')).not.toContainText('시세 갱신');
  await expect(page.getByTestId('detail')).not.toContainText('레버리지 한도');
  await page.getByTestId('lev-1').click();
  await page.getByTestId('amount').fill('100');
  await page.getByTestId('buy').click();
  await expect(page.getByTestId('cash')).toHaveText('$899.90');
  await expect(page.getByTestId('holdings')).toContainText('킹카콜라');
  await expect(page.getByTestId('tab-kingka')).toContainText('보유 1×');
  // Another leverage cannot be mixed into the same position.
  await expect(page.getByTestId('lev-10')).toBeDisabled();

  // 게이임스탑 trades frantically: the order waits 0.4-1 s, then fills at the price of that moment.
  await page.getByTestId('tab-gamestop').click();
  await page.getByTestId('buy').click();
  await expect(page.getByTestId('buy')).toHaveText('체결 중…');
  await expect(page.getByTestId('holdings')).toContainText('게이임스탑');
  await expect(page.getByTestId('cash')).toHaveText('$799.80');
  await page.getByTestId('side-sell').click();
  await page.getByTestId('sell-100').click();
  await page.getByTestId('sell').click();
  await expect(page.getByTestId('sell')).toHaveText('체결 중…');
  await expect(page.getByTestId('holdings')).not.toContainText('게이임스탑');

  // Selecting a tab shows that stock's description; there is nothing to sell there yet.
  await page.getByTestId('tab-mwodna').click();
  await expect(page.getByTestId('detail-desc')).toContainText('암 백신');
  await expect(page.getByTestId('sell')).toBeDisabled();

  // 인버스 gains when the price falls. Holding it, the same stock cannot be bought the other way.
  await page.getByTestId('side-inverse').click();
  await expect(page.getByTestId('side-note')).toContainText('내리면 이익');
  await page.getByTestId('amount').fill('100');
  await page.getByTestId('buy').click();
  await expect(page.getByTestId('tab-mwodna')).toContainText('인버스 1×');
  await expect(page.getByTestId('holdings')).toContainText('인버스 1×');
  await page.getByTestId('side-buy').click();
  await expect(page.getByTestId('buy')).toBeDisabled();
  await expect(page.getByTestId('buy-msg')).toContainText('반대 방향');

  // Too large an order is refused before it reaches the account.
  await page.getByTestId('tab-dolge').click();
  await page.getByTestId('amount').fill('5000');
  await expect(page.getByTestId('buy')).toBeDisabled();
  await expect(page.getByTestId('buy-msg')).toHaveText('예탁금이 부족합니다');

  await page.getByTestId('settle').click();
  await expect(page.getByTestId('confirm')).toBeVisible();
  await page.getByTestId('confirm-settle').click();
  await expect(page.getByTestId('result')).toContainText('정산 결과');
  await expect(page.getByTestId('result')).toContainText('거래 횟수6회'); // 킹카콜라 and the 인버스 are sold at the settlement

  await page.getByTestId('restart').click();
  await expect(app).toHaveAttribute('data-screen', 'title');
  expect(errors).toEqual([]);
});
