import { expect, test } from '@playwright/test';
import { SPEED, openAdmin, playRound, screenOf, stackShown, startPaidSession, stat } from './helpers';

test('a paid session from 새 손님 to 지급 완료 shows up in the admin stats', async ({ page }) => {
  await page.goto(`/${SPEED}`);
  await startPaidSession(page);

  let last = 5;
  let rounds = 0;
  while ((await screenOf(page)) === 'game') {
    await playRound(page, '1');
    rounds++;
    const now = await stackShown(page);
    expect([last + 2, last - 1]).toContain(now); // +2 on a hit, −1 on a miss
    last = now;
    const ended = await page.getByTestId('banner').isVisible();
    await page.keyboard.press('Enter'); // 다음 판, or 정산하기 once the session has ended
    if (ended) await expect(page.getByTestId('settlement')).toBeVisible();
    else await expect(page.locator('#app')).toHaveAttribute('data-phase', 'ready');
  }
  expect(rounds).toBeGreaterThanOrEqual(1);
  expect(rounds).toBeLessThanOrEqual(8);

  await expect(page.getByTestId('payout')).toHaveText(String(last));
  expect(last).toBeGreaterThanOrEqual(0);
  expect(last).toBeLessThanOrEqual(17);
  await page.getByTestId('paid-out').click();
  await expect(page.locator('#app')).toHaveAttribute('data-screen', 'idle');

  await openAdmin(page);
  await expect(stat(page, 'sessions')).toHaveText('1');
  expect(Number(await stat(page, 'hardest-rounds').textContent())).toBeGreaterThanOrEqual(1);
  await expect(stat(page, 'hardest-rounds')).toHaveText(String(rounds));
  await expect(stat(page, 'chips-in')).toHaveText('6');
  await expect(stat(page, 'chips-out')).toHaveText(String(last));

  // JSON export downloads the saved state.
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export').click()]);
  expect(download.suggestedFilename()).toMatch(/^yabawi-\d{8}-\d{4}\.json$/);
  const chunks: Buffer[] = [];
  for await (const c of await download.createReadStream()) chunks.push(c as Buffer);
  const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  expect(data.state.stats.sessions).toBe(1);
  expect(data.state.session).toBeNull();
});

test('admin: maxRounds clamps to 4..10 and applies to the next session; reset and restore', async ({ page }) => {
  await page.goto(`/${SPEED}`);
  await openAdmin(page);
  await page.getByTestId('set-max-rounds').fill('99');
  await page.getByTestId('settings-save').click();
  await expect(page.getByTestId('set-max-rounds')).toHaveValue('10');
  await page.keyboard.press('Escape');

  await startPaidSession(page);
  await expect(page.getByTestId('rounds')).toHaveText('0/10');
  await playRound(page, '2');
  await page.getByTestId('quit').click();
  await expect(page.getByTestId('end-reason')).toHaveText('그만하기');
  await page.getByTestId('paid-out').click();

  await openAdmin(page);
  await expect(stat(page, 'sessions')).toHaveText('1');
  await expect(stat(page, 'end-quit')).toHaveText('1');
  page.once('dialog', (d) => void d.accept()); // one confirm
  await page.getByTestId('reset-stats').click();
  await expect(stat(page, 'sessions')).toHaveText('0');
  await expect(stat(page, 'hardest-rounds')).toHaveText('0');
  await page.getByTestId('set-max-rounds').fill('1');
  await page.getByTestId('settings-save').click();
  await expect(page.getByTestId('set-max-rounds')).toHaveValue('4');
  await page.getByTestId('restore-defaults').click();
  await expect(page.getByTestId('set-max-rounds')).toHaveValue('8');
  await expect(page.getByTestId('set-pin')).toHaveValue('0000');
});
