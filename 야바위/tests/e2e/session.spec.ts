import { expect, test } from '@playwright/test';
import { SPEED, openAdmin, playRound, screenOf, stackShown, stakeShown, startPaidSession, stat } from './helpers';

test('a paid session: pick level and bet each round, play until 정산, then admin stats', async ({ page }) => {
  await page.goto(`/${SPEED}`);
  await startPaidSession(page);

  // 최상 ×2: with 5 chips the bet goes up to 2 (a loss of 4); 1 chip wins or loses 2.
  await page.getByTestId('level-hardest').click();
  await expect(page.getByTestId('bet-n')).toHaveText('1');
  await expect(page.getByTestId('stakes')).toContainText('+2');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  await expect(page.getByTestId('bet-n')).toHaveText('2');
  await expect(page.getByTestId('stakes')).toContainText('+4');
  await page.keyboard.press('ArrowDown');

  let last = 5;
  let rounds = 0;
  while ((await screenOf(page)) === 'game' && rounds < 4) {
    const amt = await stakeShown(page);
    await playRound(page, '1');
    rounds++;
    const now = await stackShown(page);
    expect([last + amt, last - amt]).toContain(now);
    last = now;
    if (await page.getByTestId('banner').isVisible()) {
      await page.keyboard.press('Enter'); // 정산하기 once the chips are gone
      break;
    }
    await page.keyboard.press('Enter'); // 다음 판
    await expect(page.locator('#app')).toHaveAttribute('data-phase', 'ready');
  }
  if ((await screenOf(page)) === 'game') await page.getByTestId('quit').click(); // 정산하기
  await expect(page.getByTestId('settlement')).toBeVisible();
  await expect(page.getByTestId('payout')).toHaveText(String(last));
  await page.getByTestId('paid-out').click();
  await expect(page.locator('#app')).toHaveAttribute('data-screen', 'idle');

  await openAdmin(page);
  await expect(stat(page, 'sessions')).toHaveText('1');
  const levelRounds = await Promise.all(['normal', 'high', 'hardest'].map(async (id) => Number(await stat(page, `${id}-rounds`).textContent())));
  expect(levelRounds.reduce((a, b) => a + b, 0)).toBe(rounds);
  await expect(stat(page, 'chips-in')).toHaveText('5');
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

test('admin: maxBet clamps to 1..20 and applies to the next session; reset and restore', async ({ page }) => {
  await page.goto(`/${SPEED}`);
  await openAdmin(page);
  await page.getByTestId('set-max-bet').fill('1');
  await page.getByTestId('settings-save').click();
  await expect(page.getByTestId('set-max-bet')).toHaveValue('1');
  await page.keyboard.press('Escape');

  await startPaidSession(page);
  await page.getByTestId('level-normal').click();
  await page.keyboard.press('ArrowUp');
  await expect(page.getByTestId('bet-n')).toHaveText('1'); // capped at 1
  await playRound(page, '2');
  await page.getByTestId('quit').click();
  await expect(page.getByTestId('end-reason')).toHaveText('정산');
  await page.getByTestId('paid-out').click();

  await openAdmin(page);
  await expect(stat(page, 'sessions')).toHaveText('1');
  await expect(stat(page, 'end-quit')).toHaveText('1');
  page.once('dialog', (d) => void d.accept()); // one confirm
  await page.getByTestId('reset-stats').click();
  await expect(stat(page, 'sessions')).toHaveText('0');
  await expect(stat(page, 'normal-rounds')).toHaveText('0');
  await page.getByTestId('set-max-bet').fill('99');
  await page.getByTestId('settings-save').click();
  await expect(page.getByTestId('set-max-bet')).toHaveValue('20');
  await page.getByTestId('restore-defaults').click();
  await expect(page.getByTestId('set-max-bet')).toHaveValue('5');
  await expect(page.getByTestId('set-pin')).toHaveValue('0000');
});
