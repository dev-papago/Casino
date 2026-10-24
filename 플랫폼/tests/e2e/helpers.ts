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

/** Sets the logged-in player's chips (an admin edit: the e2e server runs on this PC). The lobby then shows them. */
export async function setChips(page: Page, total: number): Promise<void> {
  await expect(page.getByTestId('balance')).toHaveText(/칩$/); // logged in
  await page.evaluate(async (total) => {
    const name = document.querySelector('[data-testid="who"]')?.textContent;
    const state = (await (await fetch('/api/admin/state')).json()) as { players: { id: string; name: string; pin: string; version: number }[] };
    const p = state.players.find((x) => x.name === name)!;
    await fetch('/api/admin/edit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: p.id, version: p.version, name: p.name, pin: p.pin, total }) });
  }, total);
  await expect(page.getByTestId('balance')).toHaveText(`${total}칩`, { timeout: 10_000 });
}

/** 5 chips to play with (the signup bonus, topped up). */
export const earnChips = (page: Page): Promise<void> => setChips(page, 5);
