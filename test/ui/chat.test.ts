import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import test from 'node:test';
import { uiFixture, send, completed } from './fixture.js';

test('Electron chat interface', async t => {
  const f = await uiFixture(t);
  const { app, page } = await f.launch();
  const input = page.getByLabel('消息', { exact: true });
  await t.test('renderer is isolated and receives a narrow credential-free bridge', async () => {
    const globals = await page.evaluate(() => ({ require: typeof (window as unknown as { require?: unknown }).require,
      process: typeof (window as unknown as { process?: unknown }).process, keys: Object.keys(window.dreamedge) }));
    assert.equal(globals.require, 'undefined'); assert.equal(globals.process, 'undefined');
    assert.ok(!globals.keys.includes('invoke'));
    assert.ok(!JSON.stringify(await page.evaluate(() => window.dreamedge.initialize())).includes('credentialRef'));
    const runtime = await app.evaluate(() => ({ node: process.versions.node, electron: process.versions.electron }));
    assert.ok(runtime.node && runtime.electron);
  });
  await t.test('text turns replay history; a new session remains isolated', async () => {
    await send(page, '记住暗号：琥珀'); await completed(page, '记住暗号：琥珀');
    await send(page, '查暗号'); await completed(page, '暗号是琥珀');
    await send(page, '再次确认'); await completed(page, '再次确认');
    const wire = f.server.requests[2]!.body.messages as { role: string; content: string }[];
    assert.deepEqual(wire.map(message => message.role), ['user', 'assistant', 'user', 'assistant', 'user']);
    assert.equal(wire.filter(message => message.content === '再次确认').length, 1);
    await page.getByRole('button', { name: '新对话' }).click();
    await send(page, '查暗号'); await completed(page, '这个会话没有暗号');
    assert.equal((f.server.requests[3]!.body.messages as unknown[]).length, 1);
  });
  await t.test('IME confirmation is not sent; Shift Enter inserts a newline', async () => {
    const before = f.server.requests.length;
    await input.fill('中文草稿');
    await input.evaluate(element => {
      element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, isComposing: true }));
      element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
      element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await page.waitForTimeout(80); assert.equal(f.server.requests.length, before);
    await input.press('Shift+Enter');
    assert.ok((await input.inputValue()).includes('\n'));
    await input.fill('输入法检查结束'); await input.press('Enter');
    await completed(page, '输入法检查结束');
  });
  await t.test('thinking control maps to the actual provider request', async () => {
    await page.getByLabel('思考强度').selectOption('low');
    await send(page, '低强度测试'); await completed(page, '低强度测试');
    assert.equal(f.server.requests.at(-1)!.body.reasoning_effort, 'low');
  });
  await t.test('provider failures show partial/error states and retry does not duplicate a question', async () => {
    await send(page, '触发重试');
    await page.locator('[data-status="failed"]').waitFor();
    assert.ok(!(await page.locator('body').innerText()).includes('fixture-key'));
    await page.getByRole('button', { name: '重试', exact: true }).click(); await completed(page, '重试完成');
    assert.equal(await page.getByTestId('user-message').filter({ hasText: '触发重试' }).count(), 1);
  });
  await t.test('stop cancels a streaming run and allows a fresh retry', async () => {
    await send(page, '停止这次回复');
    await page.getByTestId('assistant-message').filter({ hasText: '开头。' }).waitFor();
    await page.getByRole('button', { name: '停止生成' }).click();
    await page.locator('[data-status="cancelled"]').waitFor();
    await page.getByRole('button', { name: '重试', exact: true }).click(); await completed(page, '停止后的重试完成');
    assert.equal(await page.getByTestId('user-message').filter({ hasText: '停止这次回复' }).count(), 1);
  });
  await t.test('drafts survive switching sessions', async () => {
    await input.fill('还没有发送的草稿');
    await page.getByTestId('session-item').filter({ hasText: '记住暗号：琥珀' }).click();
    assert.equal(await input.inputValue(), '');
    await page.getByTestId('session-item').filter({ hasText: '查暗号' }).click();
    assert.equal(await input.inputValue(), '还没有发送的草稿');
  });
  await t.test('UI screenshot and responsive layout', async () => {
    await page.getByRole('button', { name: '新对话' }).click();
    await send(page, '整理一个想法'); await completed(page, '想解决什么问题');
    await mkdir('docs/validation', { recursive: true });
    await page.screenshot({ path: 'docs/validation/chat-2026-10-12.png' });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(760, 640));
    await page.waitForTimeout(100);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
    assert.equal(await page.getByRole('button', { name: '发送消息', exact: true }).isVisible(), true);
  });
  assert.deepEqual(f.errors, []);
});
