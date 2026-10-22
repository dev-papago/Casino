// Shared steps of the e2e tests.
import { expect, type Page } from '@playwright/test';

/** Signs up in the player app (a new account starts with no chips). */
export async function signUp(page: Page, name: string, pin = '1234', path = '/'): Promise<void> {
  await page.goto(path);
  await page.getByTestId('tab-signup').click();
  await page.getByTestId('name').fill(name);
  await page.getByTestId('pin').fill(pin);
  await page.getByTestId('pin2').fill(pin);
  await page.getByTestId('submit').click();
}

/**
 * The 데스 게임's reward without playing it: its server calls with the app's login (the e2e server lets the
 * stages through at once, tests/e2e/serve.ts). The lobby then shows the chips.
 */
export async function earnChips(page: Page): Promise<void> {
  await expect(page.getByTestId('balance')).toHaveText('0칩'); // logged in: the app has its token
  await page.evaluate(async () => {
    const token = localStorage.getItem('casino:v1:token');
    const post = async (path: string, body: unknown) =>
      (await fetch(`/api/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) })).json();
    const { run } = (await post('death/start', {})) as { run: string };
    for (let stage = 1; stage <= 5; stage++) await post('death/stage', { run, stage });
    await post('death/clear', { run, key: `death-${run}` });
  });
  await expect(page.getByTestId('balance')).toHaveText('5칩', { timeout: 10_000 });
}
