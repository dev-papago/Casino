// 데스 게임 in the player app: offered to a player without chips, it starts a run on the server from its title,
// and hides once the player has chips (its reward is taken through the API in the other tests).
import { expect, test, type Frame } from '@playwright/test';
import { earnChips, setChips, signUp } from './helpers.ts';

test('데스 게임 opens from the lobby, starts a run on the server, and goes back to the lobby', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await signUp(page, '도전자');
  await expect(page.getByTestId('balance')).toHaveText('2칩'); // the signup bonus: no 데스 게임 yet
  await expect(page.getByTestId('game-deathgame')).toBeHidden();
  await setChips(page, 0);
  await page.getByTestId('game-deathgame').click();
  await expect(page.getByTestId('game-layer')).toBeVisible();
  let f: Frame | undefined;
  await expect.poll(() => (f = page.frames().find((x) => x.url().includes('/games/deathgame/')))).toBeTruthy();
  await f!.waitForLoadState();
  await expect(f!.getByTestId('death-reward')).toContainText('5칩 지급');
  await expect(f!.getByTestId('death-lobby')).toBeVisible();

  // START asks the server for a run first; the first stage's briefing follows.
  await f!.locator('#btnStart').click();
  await expect(f!.locator('#stageIntroName')).toContainText('제1관문');
  await f!.locator('#btnBeginStage').click();
  await expect(f!.locator('.memory-panel h2').first()).toBeVisible();

  // The lobby's own way out.
  page.once('dialog', (d) => void d.accept());
  await page.getByTestId('game-leave').click();
  await expect(page.getByTestId('game-layer')).toBeHidden();

  // With chips the 데스 게임 is no longer offered.
  await earnChips(page);
  await expect(page.getByTestId('game-deathgame')).toBeHidden();
  expect(errors.filter((e) => !e.includes('fonts.g'))).toEqual([]);
});
