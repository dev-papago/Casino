import { execSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect, test } from '@playwright/test';
import { SPEED, openAdmin, playRound, stat } from './helpers';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const DIST = new URL('dist/', pathToFileURL(ROOT + '/'));

test.describe.configure({ mode: 'serial' });

test.beforeAll(() => {
  test.setTimeout(120_000);
  execSync('npm run build', { cwd: ROOT, stdio: 'pipe' });
});

test('npm run build leaves exactly one file: dist/index.html', () => {
  expect(readdirSync(new URL('.', DIST))).toEqual(['index.html']);
});

test('over file:// it makes no network request and keeps stats across a reload', async ({ page, context }) => {
  const requests: string[] = [];
  page.on('request', (r) => requests.push(r.url()));
  await context.route(/^https?:\/\//, (route) => route.abort());

  await page.goto(new URL(`index.html${SPEED}`, DIST).href);
  await expect(page.getByTestId('new-guest')).toBeVisible();
  await page.getByTestId('practice').click();
  await expect(page.getByTestId('badge')).toHaveText('무료 연습 · 쉬움');
  await playRound(page, '1');
  await page.reload();
  await expect(page.locator('#app')).toHaveAttribute('data-screen', 'idle');
  await openAdmin(page);
  await expect(stat(page, 'easy-rounds')).toHaveText('1');

  expect(requests.length).toBeGreaterThan(0);
  expect(requests.filter((u) => !/^(file|data|blob):/.test(u))).toEqual([]);
});
