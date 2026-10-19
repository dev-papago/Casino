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

  // Selecting a tab shows that stock's description.
  await page.getByTestId('tab-mwodna').click();
  await expect(page.getByTestId('detail-desc')).toContainText('암 백신');
  await expect(page.getByTestId('sell')).toBeDisabled();

  // $100 at 1×: the fee is 0.1% of $100.
  await page.getByTestId('lev-1').click();
  await page.getByTestId('amount').fill('100');
  await page.getByTestId('buy').click();
  await expect(page.getByTestId('cash')).toHaveText('$899.90');
  await expect(page.getByTestId('holdings')).toContainText('뭐더나');
  await expect(page.getByTestId('tab-mwodna')).toContainText('보유 1×');

  // Another leverage cannot be mixed into the same position.
  await expect(page.getByTestId('lev-10')).toBeDisabled();

  await page.getByTestId('side-sell').click();
  await page.getByTestId('sell-100').click();
  await page.getByTestId('sell').click();
  await expect(page.getByTestId('holdings')).toContainText('보유 종목이 없습니다');

  // Too large an order is refused before it reaches the account.
  await page.getByTestId('side-buy').click();
  await page.getByTestId('amount').fill('5000');
  await expect(page.getByTestId('buy')).toBeDisabled();
  await expect(page.getByTestId('buy-msg')).toHaveText('예탁금이 부족합니다');

  await page.getByTestId('settle').click();
  await expect(page.getByTestId('confirm')).toBeVisible();
  await page.getByTestId('confirm-settle').click();
  await expect(page.getByTestId('result')).toContainText('정산 결과');
  await expect(page.getByTestId('result')).toContainText('거래 횟수2회');

  await page.getByTestId('restart').click();
  await expect(app).toHaveAttribute('data-screen', 'title');
  expect(errors).toEqual([]);
});
