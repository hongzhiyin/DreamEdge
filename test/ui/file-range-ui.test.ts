import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { uiFixture, send, completed } from './fixture.js';

test('account access panel shows policy without directory controls and restores focus after ESC or reload', async t => {
  const f = await uiFixture(t); const { page } = await f.launch();
  await send(page, '测试会话'); await completed(page, '测试会话');
  await page.getByRole('button', { name: /^文件范围/ }).click();
  let panel = page.getByRole('region', { name: '文件范围设置' });
  await panel.getByText('账户权限访问', { exact: true }).waitFor();
  assert.equal(await panel.getByRole('button', { name: '选择目录' }).count(), 0);
  assert.equal(await panel.getByRole('button', { name: '开启整机访问' }).count(), 0);
  assert.match(await panel.innerText(), /覆盖、清空/); assert.match(await panel.innerText(), /deepseek-flash/);
  await page.screenshot({ path: 'docs/validation/account-permissions-2026-10-16.png' });
  await page.keyboard.press('Escape'); assert.equal(await panel.count(), 0);
  assert.equal(await page.getByRole('button', { name: /^文件范围/ }).evaluate(el => el === document.activeElement), true);
  await page.reload(); await page.getByLabel('消息', { exact: true }).waitFor();
  await page.getByRole('button', { name: /^文件范围/ }).click(); panel = page.getByRole('region', { name: '文件范围设置' });
  await panel.getByText('账户权限访问', { exact: true }).waitFor(); assert.equal(f.server.requests.length, 1);
  assert.equal(f.errors.length, 0);
});

test('account mode still blocks requests when durable conversation state cannot be saved', async t => {
  const f = await uiFixture(t); const { page } = await f.launch(); const db = new DatabaseSync(join(f.profile, 'sessions.sqlite'));
  try {
    db.exec("CREATE TRIGGER fail_account BEFORE UPDATE ON sessions BEGIN SELECT RAISE(ABORT, 'fixture'); END");
    await send(page, '保存失败'); await page.getByRole('button', { name: '重试保存' }).waitFor();
    assert.equal(f.server.requests.length, 0);
    db.exec('DROP TRIGGER fail_account'); await page.getByRole('button', { name: '重试保存' }).click();
    await page.getByText('已保存', { exact: true }).waitFor();
    await send(page, '恢复后发送'); await completed(page, '恢复后发送'); assert.equal(f.errors.length, 0);
  } finally { db.exec('DROP TRIGGER IF EXISTS fail_account'); db.close(); }
});
