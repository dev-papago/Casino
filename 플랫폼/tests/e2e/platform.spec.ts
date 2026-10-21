// One festival day in miniature: a player signs up on a player PC, the admin edits and settles on the admin PC,
// the Wi-Fi drops and comes back, the account logs in elsewhere and is finally deleted.
import { expect, test, type Page } from '@playwright/test';

async function signUp(page: Page, name: string, pin: string): Promise<void> {
  await page.goto('/');
  await page.getByTestId('tab-signup').click();
  await page.getByTestId('name').fill(name);
  await page.getByTestId('pin').fill(pin);
  await page.getByTestId('pin2').fill(pin);
  await page.getByTestId('submit').click();
}

test('signup, admin edit, settlement, network drop, another login, delete', async ({ browser }) => {
  const errors: string[] = [];
  const admin = await (await browser.newContext()).newPage();
  const playerCtx = await browser.newContext();
  const player = await playerCtx.newPage();
  for (const p of [admin, player]) p.on('pageerror', (e) => errors.push(String(e)));

  await admin.goto('/admin');
  await expect(admin.getByTestId('status')).toContainText('서버 연결됨');
  await expect(admin.getByTestId('summary')).toContainText('플레이어0명');

  // Sign up: 5 chips, and the admin sees the player online at once.
  await signUp(player, '테스터', '1234');
  await expect(player.getByTestId('balance')).toHaveText('5칩');
  await expect(player.getByTestId('who')).toHaveText('테스터');
  const row = admin.getByTestId('players').locator('tr', { hasText: '테스터' });
  await expect(row).toContainText('온라인');
  await expect(row).toContainText('1234');
  await expect(row).toContainText('5칩');
  // The same name again is refused.
  const other = await (await browser.newContext()).newPage();
  await signUp(other, '테스터', '9999');
  await expect(other.getByTestId('login-msg')).toHaveText('이미 있는 이름입니다');

  // 수정: the player's screen follows.
  await row.getByTestId('edit').click();
  await admin.getByTestId('edit-total').fill('20');
  await admin.getByTestId('dialog-ok').click();
  await expect(player.getByTestId('balance')).toHaveText('20칩');

  // 정산 요청 → the admin hands over the chips → they leave the ledger.
  await player.getByTestId('settle-amount').fill('7');
  await player.getByTestId('settle').click();
  await expect(player.getByTestId('pending')).toContainText('실물 7칩 정산 요청 중');
  await expect(player.getByTestId('breakdown')).toHaveText('사용 가능 13 · 정산 대기 7');
  const req7 = admin.getByTestId('request').filter({ hasText: '실물 7칩' });
  await req7.getByTestId('request-done').click();
  await admin.getByTestId('dialog-ok').click();
  await expect(player.getByTestId('balance')).toHaveText('13칩');
  await expect(player.getByTestId('pending')).toBeHidden();
  await expect(req7).toBeHidden(); // gone at once on the admin screen too

  // A request the admin turns down comes back.
  await player.getByTestId('settle-amount').fill('3');
  await player.getByTestId('settle').click();
  await admin.getByTestId('request').filter({ hasText: '실물 3칩' }).getByTestId('request-reject').click();
  await admin.getByTestId('dialog-ok').click();
  await expect(player.getByTestId('breakdown')).toHaveText('사용 가능 13');

  // The admin settles directly at the counter.
  await row.getByTestId('settle').click();
  await admin.getByTestId('settle-amount').fill('3');
  await admin.getByTestId('dialog-ok').click();
  await expect(player.getByTestId('balance')).toHaveText('10칩');

  // DB 기록 has every edit and settlement.
  await admin.getByTestId('tab-log').click();
  const log = admin.getByTestId('log');
  for (const kind of ['가입', '수정', '정산 요청', '정산 완료', '정산 거절', '관리자 정산']) await expect(log).toContainText(kind);
  await expect(log.locator('tr').first()).toContainText('관리자 정산');
  await admin.getByTestId('tab-players').click();

  // The Wi-Fi drops: the player app says so and blocks chip requests; the admin sees the player go offline.
  await playerCtx.setOffline(true);
  await expect(player.getByTestId('offline')).toBeVisible({ timeout: 15_000 });
  await expect(player.getByTestId('settle')).toBeDisabled();
  await expect(row).toContainText('오프라인', { timeout: 20_000 });
  await playerCtx.setOffline(false);
  await expect(player.getByTestId('offline')).toBeHidden({ timeout: 15_000 });
  await expect(row).toContainText('온라인', { timeout: 15_000 });

  // A reload keeps the login.
  await player.reload();
  await expect(player.getByTestId('balance')).toHaveText('10칩');

  // Logging in on another PC ends the first login.
  const second = await (await browser.newContext()).newPage();
  await second.goto('/');
  await second.getByTestId('name').fill('테스터');
  await second.getByTestId('pin').fill('1234');
  await second.getByTestId('submit').click();
  await expect(second.getByTestId('balance')).toHaveText('10칩');
  await expect(player.getByTestId('login-msg')).toContainText('다른 PC에서');

  // Delete: confirm first; the logged-in player is sent back to the login screen.
  await row.getByTestId('delete').click();
  await expect(admin.getByTestId('dialog')).toContainText('삭제할까요?');
  await admin.getByTestId('dialog-ok').click();
  await expect(second.getByTestId('login-msg')).toContainText('관리자가 계정을 삭제했습니다');
  await expect(admin.getByTestId('summary')).toContainText('플레이어0명');
  await admin.getByTestId('tab-log').click();
  await expect(admin.getByTestId('log').locator('tr').first()).toContainText('계정 삭제 · 잔고 10칩 소멸');
  expect(errors).toEqual([]);
});
