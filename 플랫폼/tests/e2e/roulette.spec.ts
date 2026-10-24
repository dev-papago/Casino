// 러시안 룰렛 between two player apps: one makes a room, the other joins with the same stake, the game starts
// on both screens, and giving up hands the pot to the other player.
import { expect, test, type Browser, type Frame, type Page } from '@playwright/test';
import { earnChips, signUp } from './helpers.ts';

async function seat(browser: Browser, name: string): Promise<{ page: Page; f: Frame }> {
  const page = await (await browser.newContext()).newPage();
  await signUp(page, name);
  await earnChips(page);
  await page.getByTestId('game-roulette').click();
  let f: Frame | undefined;
  await expect.poll(() => (f = page.frames().find((x) => x.url().includes('/games/roulette/')))).toBeTruthy();
  await f!.waitForLoadState();
  await expect(f!.getByTestId('rr-free')).toHaveText('5칩');
  return { page, f: f! };
}

test('러시안 룰렛: a room, a second player, the duel on both screens, and a forfeit paid to the winner', async ({ browser, request }) => {
  const a = await seat(browser, '룰렛갑');
  const b = await seat(browser, '룰렛을');
  const errors: string[] = [];
  for (const p of [a.page, b.page]) p.on('pageerror', (e) => errors.push(String(e)));

  await a.f.getByTestId('rr-stake').fill('2');
  await a.f.getByTestId('rr-lives-1').click();
  await a.f.getByTestId('rr-create').click();
  await expect(a.f.getByTestId('rr-waiting')).toBeVisible();
  await expect(a.page.getByTestId('game-balance')).toContainText('게임 중 2');

  const room = b.f.getByTestId('rr-room').filter({ hasText: '룰렛갑' });
  await expect(room).toContainText('2칩');
  await room.getByTestId('rr-join').click();
  // Both see the round loaded and then whose turn it is.
  for (const p of [a, b]) await expect(p.f.getByTestId('rr-round')).toHaveText('ROUND 1', { timeout: 10_000 });
  await expect(a.f.getByTestId('rr-waiting')).toBeHidden();
  await expect(b.f.getByTestId('rr-timer')).toBeVisible({ timeout: 15_000 });

  // 룰렛을 gives up: 룰렛갑 takes both stakes.
  await b.f.getByTestId('rr-forfeit').click();
  await b.f.getByTestId('rr-confirm-ok').click();
  await expect(b.f.getByTestId('rr-end')).toContainText('패배', { timeout: 10_000 });
  await expect(a.f.getByTestId('rr-end')).toContainText('승리', { timeout: 10_000 });
  const s = (await (await request.get('/api/admin/state')).json()) as { players: { name: string; total: number; inGame: number }[] };
  expect(s.players.find((p) => p.name === '룰렛갑')).toMatchObject({ total: 7, inGame: 0 });
  expect(s.players.find((p) => p.name === '룰렛을')).toMatchObject({ total: 3, inGame: 0 });
  expect(errors).toEqual([]);
});
