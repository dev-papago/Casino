import { expect, test } from '@playwright/test';
import { SPEED, openAdmin, playRound, screenOf, stackShown, stakeShown, startPaidSession, stat } from './helpers';

test('a paid session: pick level and bet each round, play until 정산, then admin stats', async ({ page }) => {
  await page.goto(`/${SPEED}`);
  await startPaidSession(page);

  // 최상 ×1.8: a hit wins floor(bet × 1.8), a miss loses the bet; with 5 chips the bet goes up to 5.
  await page.getByTestId('level-hardest').click();
  await expect(page.getByTestId('bet-n')).toHaveText('1');
  await expect(page.getByTestId('stakes')).toContainText('맞히면 +1 · 틀리면 −1');
  await page.keyboard.press('End');
  await expect(page.getByTestId('bet-n')).toHaveText('5');
  await expect(page.getByTestId('stakes')).toContainText('맞히면 +9 · 틀리면 −5');
  await page.keyboard.press('Home');

  let last = 5;
  let rounds = 0;
  while ((await screenOf(page)) === 'game' && rounds < 4) {
    const amt = await stakeShown(page);
    await playRound(page, '1');
    rounds++;
    const now = await stackShown(page);
    expect([last + amt.win, last - amt.lose]).toContain(now);
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

test('no table limit: the bet goes up to what the chips can lose; admin reset and restore', async ({ page }) => {
  await page.goto(`/${SPEED}`);
  await openAdmin(page);
  await expect(page.getByTestId('admin')).not.toContainText('최대 판돈');
  await page.keyboard.press('Escape');

  await startPaidSession(page);
  await page.getByTestId('level-normal').click();
  await page.getByTestId('bet-max').click();
  await expect(page.getByTestId('bet-n')).toHaveText('5'); // a miss loses only the bet: all 5 chips can go
  await expect(page.getByTestId('bet-plus')).toBeDisabled();
  await page.keyboard.press('Home');
  await expect(page.getByTestId('bet-n')).toHaveText('1');
  await page.keyboard.press('End');
  await expect(page.getByTestId('bet-n')).toHaveText('5');
  await page.getByTestId('level-hardest').click();
  await expect(page.getByTestId('bet-n')).toHaveText('5'); // same on every level
  await page.getByTestId('level-normal').click();
  await page.keyboard.press('ArrowDown');
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
  await page.getByTestId('set-pin').fill('4321');
  await page.getByTestId('settings-save').click();
  await expect(page.getByTestId('set-pin')).toHaveValue('4321');
  await page.getByTestId('restore-defaults').click();
  await expect(page.getByTestId('set-pin')).toHaveValue('0000');
});

test('the payout stops at 50 chips: the bet is limited and reaching 50 settles by itself', async ({ page }) => {
  // Start from a saved session at 49 chips: the bet is capped at 1 (a hit reaches 50), then win once.
  const seed = async (): Promise<void> => {
    await page.evaluate(() => {
      const session = { id: 's-cap', startedAt: 0, econ: { buyIn: 5, autoSettleAt: 50 }, stack: 49, rounds: [], ended: null };
      localStorage.setItem('yabawi:v2:state', JSON.stringify({ session, stats: null }));
    });
    await page.reload();
    await expect(page.locator('#app')).toHaveAttribute('data-phase', 'ready');
  };
  await page.goto(`/${SPEED}`);
  for (let i = 0; i < 25; i++) {
    await seed();
    await expect(page.getByTestId('stack-n')).toHaveText('49');
    await page.getByTestId('level-hardest').click();
    await page.keyboard.press('End');
    await expect(page.getByTestId('bet-n')).toHaveText('1'); // 49 + floor(2 × 1.8) = 52 would pass 50
    await expect(page.getByTestId('bet-max')).toBeDisabled();
    await expect(page.getByTestId('level-picker').locator('..')).toContainText('50칩 한도');
    await playRound(page, String(1 + (i % 3)));
    if ((await stackShown(page)) === 50) break;
  }
  expect(await stackShown(page)).toBe(50);
  await expect(page.getByTestId('banner')).toHaveText('50칩 달성! 자동 정산');
  await expect(page.getByTestId('quit')).toHaveCount(0); // nothing left to play
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('end-reason')).toHaveText('50칩 달성! 자동 정산');
  await expect(page.getByTestId('payout')).toHaveText('50');
});
