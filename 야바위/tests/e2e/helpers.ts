// Shared steps for the e2e specs. The app exposes its screen and phase as data attributes on #app.
import { expect, type Locator, type Page } from '@playwright/test';

export const SPEED = '?speed=20';

/** Waits for a phase on every animation frame (a shuffle at ?speed=20 lasts only ~0.2 s). */
export async function waitPhase(page: Page, phase: string): Promise<void> {
  await page.waitForFunction((p) => document.getElementById('app')?.dataset.phase === p, phase, { polling: 'raf' });
}

export const screenOf = (page: Page): Promise<string | undefined> =>
  page.evaluate(() => document.getElementById('app')?.dataset.screen);

/** [섞기 시작] with Space, then pick with a key and wait for the result. */
export async function playRound(page: Page, key = '1'): Promise<void> {
  await waitPhase(page, 'ready');
  await page.keyboard.press('Space');
  await waitPhase(page, 'picking');
  await page.keyboard.press(key);
  await waitPhase(page, 'result');
}

export async function stackShown(page: Page): Promise<number> {
  return Number(await page.getByTestId('stack-n').textContent());
}

export async function startPaidSession(page: Page): Promise<void> {
  await page.getByTestId('new-guest').click();
  await expect(page.getByTestId('confirm')).toContainText('손님에게 칩 5개를 받으세요');
  await page.getByTestId('confirm-start').click();
  await expect(page.getByTestId('stack')).toHaveText('칩 5개');
}

/** The chips a hit wins and a miss loses for the chosen level and bet, read from the status bar. */
export async function stakeShown(page: Page): Promise<{ win: number; lose: number }> {
  const m = /맞히면 \+(\d+).*틀리면 −(\d+)/.exec((await page.getByTestId('stakes').textContent()) ?? '');
  if (!m) throw new Error('no stakes shown');
  return { win: Number(m[1]), lose: Number(m[2]) };
}

export async function openAdmin(page: Page, pin = '0000'): Promise<void> {
  for (let i = 0; i < 5; i++) await page.getByTestId('title').click();
  await page.getByTestId('pin-input').fill(pin);
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('admin')).toBeVisible();
}

export const stat = (page: Page, key: string): Locator => page.locator(`[data-stat="${key}"]`);
