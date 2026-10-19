import { expect, test } from '@playwright/test';
import { SPEED, playRound, stackShown, stakeShown, startPaidSession, waitPhase } from './helpers';

test('reload before the pick voids the round; after the pick it counts; settlement survives reload', async ({ page }) => {
  await page.goto(`/${SPEED}`);
  await startPaidSession(page);
  for (let i = 0; i < 2; i++) {
    await playRound(page, '1');
    await page.keyboard.press('Enter');
  }
  await waitPhase(page, 'ready');
  const stack = await stackShown(page);
  await expect(page.getByTestId('rounds')).toHaveText('2');
  const amt = await stakeShown(page);

  // Round 3, reloaded mid-shuffle: nothing was staked yet, so the round never happened.
  await page.keyboard.press('Space');
  await waitPhase(page, 'shuffling');
  await page.reload();
  await expect(page.locator('#app')).toHaveAttribute('data-screen', 'game');
  await expect(page.locator('#app')).toHaveAttribute('data-phase', 'ready');
  await expect(page.getByTestId('rounds')).toHaveText('2');
  expect(await stackShown(page)).toBe(stack);
  await expect(page.getByTestId('start-round')).toBeVisible();

  // Same round again from 섞기 시작; reloaded during the reveal, the pick already counts.
  await page.keyboard.press('Space');
  await waitPhase(page, 'picking');
  await page.keyboard.press('3');
  await waitPhase(page, 'reveal');
  await page.reload();
  await expect(page.locator('#app')).toHaveAttribute('data-phase', 'ready');
  await expect(page.getByTestId('rounds')).toHaveText('3');
  const after = await stackShown(page);
  expect([stack + amt, stack - amt]).toContain(after);

  // [정산하기] → settlement; a reload shows the same number again.
  await page.getByTestId('quit').click();
  await expect(page.getByTestId('payout')).toHaveText(String(after));
  await page.reload();
  await expect(page.getByTestId('settlement')).toBeVisible();
  await expect(page.getByTestId('payout')).toHaveText(String(after));
  await expect(page.getByTestId('end-reason')).toHaveText('정산');
});
