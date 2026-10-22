// The games inside the platform: chips go from the ledger into 야바위 and 영끌문S and back, and no way of
// stopping a game (a reload mid-round, the lobby closing it, a dropped Wi-Fi at the end) loses or makes chips.
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
  await register(page, name, '1234', '/?speed=20');
  await earnChips(page);
}

async function gameFrame(page: Page, id: string): Promise<Frame> {
  await page.getByTestId(`game-${id}`).click();
  await expect(page.getByTestId('game-layer')).toBeVisible();
  let f: Frame | undefined;
  await expect.poll(() => (f = page.frames().find((x) => x.url().includes(`/games/${id}/`)))).toBeTruthy();
  await f!.waitForLoadState();
  return f!;
}

const waitPhase = (f: Frame, phase: string) =>
  f.waitForFunction((p) => document.getElementById('app')?.dataset.phase === p, phase, { polling: 'raf' });

test('야바위 takes chips from the ledger and gives the stack back; a reload mid-round loses the bet', async ({ page, request }) => {
  await signUp(page, '야바위꾼');
  let f = await gameFrame(page, 'yabawi');
  await f.getByTestId('new-guest').click();
  await expect(f.getByTestId('stake-n')).toHaveText('5');
  await f.getByTestId('stake-minus').click();
  await f.getByTestId('stake-minus').click();
  await f.getByTestId('stake-start').click();
  await expect(f.getByTestId('stack-n')).toHaveText('3');
  await expect(page.getByTestId('game-balance')).toContainText('게임 중 3');

  // One round with a 1-chip bet, then 정산 → 칩 받기: the stack goes back to the ledger.
  await waitPhase(f, 'ready');
  await f.getByTestId('start-round').click();
  await waitPhase(f, 'picking');
  await f.locator('.zone').first().click();
  await waitPhase(f, 'result');
  const stack = Number(await f.getByTestId('stack-n').textContent());
  await f.getByTestId('next-round').click();
  await waitPhase(f, 'ready');
  await f.getByTestId('quit').click();
  await f.getByTestId('paid-out').click();
  await expect(f.getByTestId('casino-done')).toContainText(`${stack}칩이 내 잔고로`);
  await expect.poll(async () => (await ledger(request, '야바위꾼')).p).toMatchObject({ total: 2 + stack, inGame: 0 });

  // Mid-round reload: the bet is on the table, so it is lost; the rest comes back.
  await f.getByTestId('new-guest').click();
  await f.getByTestId('stake-minus').click(); // from min(5, free) down by one
  const brought = Number(await f.getByTestId('stake-n').textContent());
  await f.getByTestId('stake-start').click();
  await waitPhase(f, 'ready');
  await f.getByTestId('bet-max').click();
  const bet = Number(await f.getByTestId('bet-n').textContent());
  await f.getByTestId('start-round').click();
  await waitPhase(f, 'shuffling');
  const before = (await ledger(request, '야바위꾼')).p.total;
  await page.reload();
  await expect(page.getByTestId('balance')).toBeVisible();
  await expect.poll(async () => await ledger(request, '야바위꾼')).toMatchObject({ open: 0, p: { total: before - bet, inGame: 0 } });
  expect(bet).toBeGreaterThanOrEqual(1);
  expect(brought).toBeGreaterThanOrEqual(bet);

  // Back in the game the stake card works again (the leftover is gone).
  f = await gameFrame(page, 'yabawi');
  await expect(f.getByTestId('new-guest')).toBeVisible();
});

test('영끌문S turns chips into dollars and back; closing it from the lobby settles at its value', async ({ page, request }) => {
  await signUp(page, '트레이더');
  let f = await gameFrame(page, 'yeongkkeul');
  await expect(f.getByTestId('wallet')).toContainText('사용 가능한 칩 5개');
  await f.getByTestId('stake-plus').click(); // 1 → 2
  await expect(f.getByTestId('stake-n')).toHaveText('2칩');
  await f.getByTestId('start').click();
  await expect(f.getByTestId('equity')).toHaveText('$2,000.00'); // 1 chip = $1,000, no entry fee
  await expect(page.getByTestId('game-balance')).toContainText('게임 중 2');
  // Leverage opens at twice the deposit brought in.
  await expect(f.getByTestId('lev-lock')).toContainText('$4,000');

  // 정산 with nothing bought: the same 2 chips back (no bonus without a position).
  await page.waitForTimeout(1500);
  await expect(f.getByTestId('equity')).toHaveText('$2,000.00');
  await f.getByTestId('settle').click();
  await f.getByTestId('confirm-settle').click();
  await expect(f.getByTestId('cashout')).toHaveText('2칩이 내 잔고로 들어갔습니다');
  const back = 2;
  await expect.poll(async () => (await ledger(request, '트레이더')).p).toMatchObject({ total: 3 + back, inGame: 0 });
  await f.getByTestId('to-lobby').click();
  await expect(page.getByTestId('game-layer')).toBeHidden();

  // Left in the middle from the lobby: settled at what the game was worth.
  f = await gameFrame(page, 'yeongkkeul');
  await expect(f.getByTestId('wallet')).toContainText(`사용 가능한 칩 ${3 + back}개`);
  await f.getByTestId('start').click();
  await expect(f.getByTestId('equity')).toHaveText('$1,000.00');
  page.once('dialog', (d) => void d.accept());
  await page.getByTestId('game-leave').click();
  await expect.poll(async () => (await ledger(request, '트레이더')).open).toBe(0);
  const left = (await ledger(request, '트레이더')).p; // $1,000: the chip back
  expect(left.inGame).toBe(0);
  expect(left.total).toBe(3 + back);
});

test('a result sent while the Wi-Fi is down arrives when it is back', async ({ page, request, context }) => {
  await signUp(page, '끊김');
  const f = await gameFrame(page, 'yabawi');
  await f.getByTestId('new-guest').click();
  await f.getByTestId('stake-start').click();
  await waitPhase(f, 'ready');
  await f.getByTestId('quit').click();
  await context.setOffline(true);
  await f.getByTestId('paid-out').click();
  await expect(f.getByTestId('casino-done')).toContainText('보내는 중', { timeout: 15_000 });
  expect((await ledger(request, '끊김')).p.inGame).toBe(5);
  await context.setOffline(false);
  // The lobby's next report sends it.
  await expect.poll(async () => (await ledger(request, '끊김')).p, { timeout: 20_000 }).toMatchObject({ total: 5, inGame: 0 });
});
