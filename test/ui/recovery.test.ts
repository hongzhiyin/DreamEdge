import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { uiFixture, send, completed } from './fixture.js';

test('Electron save and window recovery', async t => {
  const f = await uiFixture(t);
  const { app, page } = await f.launch();
  const input = page.getByLabel('消息', { exact: true });
  await t.test('saving failures are visible and block sending until save-only retry succeeds', async () => {
    const database = new DatabaseSync(join(f.profile, 'sessions.sqlite'));
    try {
      database.exec(`CREATE TRIGGER fail_final BEFORE UPDATE ON runs WHEN NEW.status = 'completed'
        BEGIN SELECT RAISE(ABORT, 'fixture save failure'); END`);
      await send(page, '保存失败检查');
      await completed(page, '保存失败检查');
      await page.getByRole('button', { name: '重试保存' }).waitFor();
      await input.fill('保存后可继续');
      assert.equal(await page.getByRole('button', { name: '发送消息', exact: true }).isDisabled(), true);
      const before = f.server.requests.length;
      database.exec('DROP TRIGGER fail_final');
      await page.getByRole('button', { name: '重试保存' }).click();
      await page.getByText('已保存', { exact: true }).waitFor();
      assert.equal(f.server.requests.length, before);
      await page.getByRole('button', { name: '发送消息', exact: true }).click();
      await completed(page, '保存后可继续');
    } finally { database.close(); }
  });
  await t.test('reading position and drafts survive hiding, missed events and renderer reload', async () => {
    await send(page, '长历史'); await completed(page, '第 80 段');
    await send(page, '连续输出');
    await page.getByTestId('assistant-message').filter({ hasText: '开头。' }).waitFor();
    await input.fill('窗口恢复后仍然保留的草稿');
    const scroll = page.getByTestId('messages-scroll');
    await scroll.evaluate(element => { element.scrollTop = 0; });
    await page.getByRole('button', { name: '回到最新' }).waitFor();
    const count = f.server.requests.length;
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close());
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isVisible()), false);
    for (let i = 1; i <= 40; i++) { f.append(`片段${i}。`); await delay(55); }
    f.finish(); await delay(100);
    await app.evaluate(({ app }) => { app.emit('activate'); });
    try { await completed(page, '片段40', 'attached'); }
    catch (error) {
      const diagnostic = await page.evaluate(async () => {
        const result = await window.dreamedge.watch(sessionStorage.getItem('dreamedge:selected')!);
        const event = result.kind === 'snapshot' ? result.event : result.events.at(-1);
        const attempt = event?.view.messages.at(-1)?.attempts.at(-1);
        const latest = [...document.querySelectorAll('[data-testid="assistant-message"]')].at(-1);
        return { visibility: document.visibilityState, status: attempt?.status, tail: attempt?.text.slice(-100), error: attempt?.error,
          domStatus: latest?.getAttribute('data-status'), domTail: latest?.textContent?.slice(-100) };
      });
      process.stderr.write(`Window recovery diagnostic: ${JSON.stringify(diagnostic)}\n`); throw error;
    }
    const text = await page.getByTestId('assistant-message').last().innerText();
    assert.equal((text.match(/片段/g) ?? []).length, 40);
    assert.equal(f.server.requests.length, count, 'Window recovery cannot submit another model request');
    assert.ok((await scroll.evaluate(element => element.scrollTop)) < 5);
    assert.equal(await input.inputValue(), '窗口恢复后仍然保留的草稿');
    await page.getByRole('button', { name: '回到最新' }).click();
    await completed(page, '片段40');
    assert.ok((await scroll.evaluate(element => element.scrollTop)) > 100);
    await page.reload();
    await page.getByLabel('消息', { exact: true }).waitFor(); await completed(page, '片段40');
    assert.equal(await page.getByLabel('消息', { exact: true }).inputValue(), '窗口恢复后仍然保留的草稿');
    assert.equal(f.server.requests.length, count);
  });
  await t.test('normal application exit persists history and restart continues the same conversation', async () => {
    await page.getByText('已保存', { exact: true }).waitFor();
    const count = f.server.requests.length;
    await app.close();
    const restarted = await f.launch();
    await completed(restarted.page, '片段40');
    assert.equal(f.server.requests.length, count);
    await send(restarted.page, '重启后继续'); await completed(restarted.page, '重启后继续');
    const wire = f.server.requests.at(-1)!.body.messages as { role: string; content: string }[];
    assert.ok(wire.some(message => message.role === 'assistant' && message.content.includes('片段40')));
    assert.equal(wire.filter(message => message.content === '重启后继续').length, 1);
  });
  assert.deepEqual(f.errors, []);
});
