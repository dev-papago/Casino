// One full game: start, pick a stock, buy, sell, settle, back to the title.
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

  // Tabs run from the easiest stock to the hardest, and the game clock counts down to the close.
  const order = await page.locator('.tab').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')));
  expect(order).toEqual(['tab-kingka', 'tab-lownix', 'tab-dolge', 'tab-mwodna', 'tab-gamestop']);
  await expect(page.getByTestId('clock')).toHaveText(/^0[45]:\d\d$/);

  // Leverage stays locked until the equity reaches econ.leverageFrom ($2,000).
  await expect(page.getByTestId('lev-5')).toBeDisabled();
  await expect(page.getByTestId('lev-lock')).toBeVisible();

  // The mouse wheel zooms the chart: down shows more (thinner) candles, up fewer (wider) ones.
  const chart = page.locator('.chart');
  await expect(chart).toHaveAttribute('data-candles', '100');
  await chart.hover();
  await page.mouse.wheel(0, 300);
  await expect.poll(async () => Number(await chart.getAttribute('data-candles'))).toBeGreaterThan(100);
  for (let i = 0; i < 4; i++) await page.mouse.wheel(0, -100); // one notch each
  await expect.poll(async () => Number(await chart.getAttribute('data-candles'))).toBeLessThan(100);

  // 킹카콜라 trades little: it fills at once, at the shown price. $100 at 1× pays a $0.10 fee.
  await expect(page.getByTestId('detail-fill')).toContainText('즉시');
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
  await expect(page.getByTestId('detail-fill')).toContainText('0.4~1.0초');
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

  // Too large an order is refused before it reaches the account.
  await page.getByTestId('side-buy').click();
  await page.getByTestId('amount').fill('5000');
  await expect(page.getByTestId('buy')).toBeDisabled();
  await expect(page.getByTestId('buy-msg')).toHaveText('예탁금이 부족합니다');

  await page.getByTestId('settle').click();
  await expect(page.getByTestId('confirm')).toBeVisible();
  await page.getByTestId('confirm-settle').click();
  await expect(page.getByTestId('result')).toContainText('정산 결과');
  await expect(page.getByTestId('result')).toContainText('거래 횟수4회'); // 킹카콜라 is sold at the settlement

  await page.getByTestId('restart').click();
  await expect(app).toHaveAttribute('data-screen', 'title');
  expect(errors).toEqual([]);
});
