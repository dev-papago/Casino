// 플링코, 슬롯머신, 요트 다이스 in the platform: every round takes its stake from the ledger and gives the drawn
// payout back, and a round left in the middle (reload) is settled by the next start, not lost or refunded.
import { expect, test, type APIRequestContext, type Frame, type Page } from '@playwright/test';
import { earnChips, signUp as register } from './helpers.ts';

interface Ledger {
  players: { name: string; total: number; free: number; inGame: number }[];
  games: unknown[];
}
const ledger = async (request: APIRequestContext, name: string) => {
  const s = (await (await request.get('/api/admin/state')).json()) as Ledger;
  return { p: s.players.find((x) => x.name === name)!, open: s.games.length };
};

async function signUp(page: Page, name: string): Promise<void> {
  await register(page, name, '1234', '/');
  await earnChips(page);
}

async function gameFrame(page: Page, id: string): Promise<Frame> {
  await page.getByTestId(`game-${id}`).click();
  await expect(page.getByTestId('game-layer')).toBeVisible();
  let f: Frame | undefined;
  await expect.poll(() => (f = page.frames().find((x) => x.url().includes(`/games/${id}/`)))).toBeTruthy();
  await f!.waitForLoadState();
  await expect(f!.getByTestId('arcade-balance')).toHaveText('5칩');
  return f!;
}

/** The multiplier shown in the result line ("×8 · +7칩", "요트 (6) ×20 · …", "꽝 · −1칩"). */
async function resultMult(f: Frame): Promise<number> {
  const line = f.getByTestId('result-line');
  await expect(line).toHaveText(/(×\d+ · |꽝 · )/, { timeout: 20_000 });
  const m = /×(\d+)/.exec((await line.textContent()) ?? '');
  return m ? Number(m[1]) : 0;
}

test('플링코: one ball is one 1-chip round', async ({ page, request }) => {
  await signUp(page, '플링코손님');
  const f = await gameFrame(page, 'plinko');
  await f.getByTestId('board-easy').click();
  await f.getByTestId('drop').click();
  const mult = await resultMult(f);
  await expect.poll(async () => (await ledger(request, '플링코손님')).open).toBe(0);
  expect((await ledger(request, '플링코손님')).p).toMatchObject({ total: 4 + mult, inGame: 0 });
});

test('슬롯머신: a spin pays its line', async ({ page, request }) => {
  await signUp(page, '슬롯손님');
  const f = await gameFrame(page, 'slot');
  await f.getByTestId('stake-up').click();
  await expect(f.getByTestId('stake')).toHaveText('2칩');
  await f.getByTestId('spin').click();
  const mult = await resultMult(f);
  await expect.poll(async () => (await ledger(request, '슬롯손님')).open).toBe(0);
  expect((await ledger(request, '슬롯손님')).p).toMatchObject({ total: 3 + 2 * mult, inGame: 0 });
});

test('요트 다이스: three rolls with a lock, and a round left in the middle is still settled', async ({ page, request }) => {
  await signUp(page, '요트손님');
  let f = await gameFrame(page, 'yacht');
  await f.getByTestId('yacht-main').click();
  await expect(f.getByTestId('yacht-main')).toHaveText(/남은 2번/);
  await f.getByTestId('die-0').click();
  await f.getByTestId('yacht-main').click();
  await expect(f.getByTestId('yacht-main')).toHaveText(/남은 1번/);
  await expect(f.getByTestId('die-0')).toBeDisabled(); // held for a roll: locked
  await f.getByTestId('yacht-main').click();
  const mult = await resultMult(f);
  await expect.poll(async () => (await ledger(request, '요트손님')).open).toBe(0);
  const total = 4 + mult;
  expect((await ledger(request, '요트손님')).p).toMatchObject({ total, inGame: 0 });

  // Start a round, then reload: the round stays open in the ledger until the game starts again and settles it.
  await f.getByTestId('yacht-main').click();
  await expect(f.getByTestId('yacht-main')).toHaveText(/남은 2번/);
  await expect.poll(async () => (await ledger(request, '요트손님')).open).toBe(1);
  await f.evaluate(() => location.reload());
  f = page.frames().find((x) => x.url().includes('/games/yacht/'))!;
  await f.waitForLoadState();
  await expect.poll(async () => (await ledger(request, '요트손님')).open).toBe(0);
  const after = (await ledger(request, '요트손님')).p;
  expect(after.inGame).toBe(0);
  expect(after.total - (total - 1)).toBeGreaterThanOrEqual(0); // paid what the rolled-out hand pays (0 … 20)
  expect(after.total - (total - 1)).toBeLessThanOrEqual(20);
});

test('순위 대시보드 lists players by 잔고 on the admin PC', async ({ page, browser }) => {
  await signUp(page, '순위왕');
  const board = await browser.newPage();
  await board.goto('/rank');
  await expect(board.getByTestId('podium')).toContainText('순위왕');
  await expect(board.locator('.rk-stats')).toContainText('전체 잔고 합계');
  await board.close();
});

test('the lobby shows the ranking on the left', async ({ page }) => {
  await signUp(page, '왼쪽순위');
  await expect(page.getByTestId('rank-panel')).toContainText('왼쪽순위');
  await expect(page.getByTestId('rank-panel').getByTestId('rank-me')).toContainText('내 순위');
});

test('확률 시뮬레이터 draws the distribution of chips left', async ({ page }) => {
  await page.goto('/sim');
  await page.getByTestId('sim-game').getByText('슬롯머신').click();
  await page.getByTestId('sim-run').click();
  await expect(page.getByTestId('sim-status')).toContainText('완료', { timeout: 30_000 });
  await expect(page.locator('.sm-bar').first()).toBeVisible();
  await expect(page.locator('.sm-tile').first()).toContainText('평균 남는 칩');
});
