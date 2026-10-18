import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { resolve } from 'node:path';
import { startWebHost } from '../../web/server.js';
import { ChatHub } from '../../src/chat/hub.js';
import { conversationFixture } from '../helpers/conversation.js';

async function until(condition: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!condition()) { if (Date.now() > deadline) throw new Error('Expected host operation did not arrive'); await new Promise(resolve => setTimeout(resolve, 20)); }
}

test('existing chat renderer works in a narrow paired browser with streaming and reload recovery', { timeout: 30_000 }, async () => {
  const f = conversationFixture(), hub = new ChatHub(f.service, f.config, 32, 1);
  const host = await startWebHost({ hub, rendererDirectory: resolve('dist/renderer') });
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 420, height: 800 } });
    const page = await context.newPage(), errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(host.url);
    await page.getByLabel('一次性配对码').fill(host.issuePairingCode().code);
    await page.getByRole('button', { name: '连接', exact: true }).click();
    await page.getByLabel('消息', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => document.cookie), '');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    const input = page.getByLabel('消息', { exact: true });
    const bounds = await input.boundingBox(); assert.ok(bounds && bounds.width > 250 && bounds.y + bounds.height <= 800);
    await input.fill('网页传输测试'); await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await until(() => f.calls.length === 1);
    await f.calls[0]!.emit(1, '来自现有会话服务');
    await page.getByText('来自现有会话服务', { exact: true }).waitFor();
    f.calls[0]!.finish('completed', '来自现有会话服务');
    await page.getByRole('button', { name: '发送消息', exact: true }).waitFor();
    await page.getByRole('button', { name: /新对话/ }).first().click();
    await page.getByTestId('session-item').filter({ hasText: '网页传输测试' }).click();
    await page.getByText('来自现有会话服务', { exact: true }).waitFor();
    const history = await page.getByRole('navigation', { name: '历史对话' }).boundingBox();
    assert.ok(history && history.height >= 40);
    await input.fill('重开后保留的草稿');
    await page.reload();
    await page.getByText('来自现有会话服务', { exact: true }).waitFor();
    assert.equal(await page.getByLabel('消息', { exact: true }).inputValue(), '重开后保留的草稿');
    assert.equal(f.calls.length, 1); assert.deepEqual(errors, []);
    host.revokeAll();
    await page.getByLabel('一次性配对码').waitFor();
  } finally { await browser.close(); await host.close(); hub.dispose(); await f.service.dispose(); }
});
