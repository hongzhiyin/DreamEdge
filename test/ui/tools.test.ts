import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ElectronApplication, Page } from 'playwright';
import { uiFixture, send } from './fixture.js';
import { toolReply } from '../helpers/tool-loop.js';
import { chatReply } from '../helpers/server.js';

const writes = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { fixtureWrites: number }).fixtureWrites);
async function settled(page: Page) {
  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="assistant-message"]')].at(-1)?.getAttribute('data-status') === 'completed');
  assert.ok((await page.getByTestId('assistant-message').last().innerText()).includes('Hello world'));
}

test('tool cards, authorization and model turns in the Electron chat', async t => {
  let id = 0; let failedContinuation = false;
  const f = await uiFixture(t, { tools: true, entry: fileURLToPath(new URL('./tools-host.js', import.meta.url)),
    handler(response, request) {
      const messages = request.body.messages as { role: string; content: string }[];
      const question = messages.filter(message => message.role === 'user').at(-1)!.content;
      if (messages.at(-1)?.role === 'tool') {
        if (question === '续答测试' && !failedContinuation) {
          failedContinuation = true; response.writeHead(500); response.end('fixture'); return;
        }
        chatReply(response); return;
      }
      toolReply(response, [{ id: `call-${++id}`, name: question === '加法' ? 'add_numbers'
        : question === '结果未知' ? 'slow_write' : 'fixture_write', args: question === '加法' ? { a: 2, b: 3 } : { value: 7 } }]);
    } });
  const { app, page } = await f.launch();
  await t.test('read results and reasoning remain visible after model continuation', async () => {
    await send(page, '加法'); await settled(page);
    const card = page.getByTestId('tool-card').last(); assert.equal(await card.getAttribute('data-status'), 'succeeded');
    await card.getByText('参数与详情').click(); assert.ok((await card.innerText()).includes('"a": 2'));
    assert.ok((await card.innerText()).includes('5')); assert.equal(await page.getByText('思考过程', { exact: true }).count(), 2);
  });
  await t.test('confirmation survives hidden window and renderer reload; double click executes once', async () => {
    await send(page, '确认测试'); const card = page.getByTestId('tool-card').last();
    await card.getByRole('button', { name: '允许这一次' }).waitFor();
    assert.equal(await writes(app), 0); assert.ok((await card.innerText()).includes('隔离测试计数器'));
    await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]!; window.hide(); window.show(); });
    await page.reload(); await card.getByRole('button', { name: '允许这一次' }).waitFor();
    assert.equal(f.server.requests.length, 3); assert.equal(await writes(app), 0);
    await card.getByRole('button', { name: '允许这一次' }).evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
    await settled(page); assert.equal(await writes(app), 1);
    await mkdir('docs/validation', { recursive: true });
    await page.screenshot({ path: 'docs/validation/tool-chat-2026-10-14.png' });
  });
  await t.test('rejecting and stopping a pending confirmation do not write', async () => {
    await send(page, '拒绝测试'); let card = page.getByTestId('tool-card').last();
    await card.getByRole('button', { name: '拒绝', exact: true }).click(); await settled(page);
    assert.equal(await card.getAttribute('data-status'), 'rejected'); assert.equal(await writes(app), 1);
    await send(page, '停止等待'); card = page.getByTestId('tool-card').last();
    await card.getByRole('button', { name: '允许这一次' }).waitFor();
    await page.getByRole('button', { name: '停止生成' }).click();
    await page.locator('[data-testid="assistant-message"][data-status="cancelled"]').last().waitFor();
    assert.equal(await card.getAttribute('data-status'), 'cancelled'); assert.equal(await writes(app), 1);
    assert.equal(await card.getByRole('button', { name: '允许这一次' }).count(), 0);
  });
  await t.test('model continuation reuses a successful write; action is not repeated', async () => {
    await send(page, '续答测试'); const card = page.getByTestId('tool-card').last();
    await card.getByRole('button', { name: '允许这一次' }).click();
    await page.getByRole('button', { name: '继续回答', exact: true }).last().click();
    await settled(page); assert.equal(await writes(app), 2);
  });
  await t.test('save-only retry persists a tool result without repeating the write', async () => {
    const before = await writes(app); const db = new DatabaseSync(join(f.profile, 'sessions.sqlite'));
    try {
      db.exec(`CREATE TRIGGER fail_tool_result BEFORE INSERT ON run_messages
        WHEN json_extract(NEW.record, '$.message.role') = 'toolResult' BEGIN SELECT RAISE(ABORT, 'fixture'); END`);
      await send(page, '保存测试'); const card = page.getByTestId('tool-card').last();
      await card.getByRole('button', { name: '允许这一次' }).click();
      await page.getByRole('button', { name: '重试保存', exact: true }).waitFor();
      assert.equal(await writes(app), before + 1); const requests = f.server.requests.length;
      db.exec('DROP TRIGGER fail_tool_result');
      await page.getByRole('button', { name: '重试保存', exact: true }).click(); await settled(page);
      assert.equal(await writes(app), before + 1); assert.equal(f.server.requests.length, requests + 1);
    } finally { db.close(); }
  });
  await t.test('permission controls support keyboard focus, narrow desktop layout and reduced motion', async () => {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(760, 650));
    await page.emulateMedia({ reducedMotion: 'reduce' }); await send(page, '布局测试');
    const card = page.getByTestId('tool-card').last(); const button = card.getByRole('button', { name: '允许这一次' });
    await button.waitFor(); await button.focus(); assert.ok(await button.evaluate(element => element === document.activeElement));
    const box = await button.boundingBox(); assert.ok(box && box.height >= 40);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth));
    await page.screenshot({ path: 'docs/validation/tool-approval-2026-10-14.png' });
    await card.getByRole('button', { name: '拒绝', exact: true }).press('Enter'); await settled(page);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1160, 800));
  });
  await t.test('unknown write outcome is explicit and exposes no retry action', async () => {
    await send(page, '结果未知'); const card = page.getByTestId('tool-card').last();
    await card.getByRole('button', { name: '允许这一次' }).click();
    await page.waitForFunction(() => document.querySelector('[data-testid="tool-card"]:last-child')?.getAttribute('data-status') === 'running'
      || [...document.querySelectorAll('[data-testid="tool-card"]')].at(-1)?.getAttribute('data-status') === 'running');
    await page.getByRole('button', { name: '停止生成' }).click();
    await page.locator('[data-testid="tool-card"][data-status="outcome_unknown"]').waitFor();
    const attempt = page.getByTestId('assistant-message').last(); assert.ok((await attempt.innerText()).includes('请先核对实际结果'));
    assert.equal(await attempt.getByRole('button', { name: '继续回答' }).count(), 0); assert.equal(await writes(app), 4);
  });
  assert.deepEqual(f.errors, []);
});
