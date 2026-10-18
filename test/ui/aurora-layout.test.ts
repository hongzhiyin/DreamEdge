import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, type Page } from 'playwright';
import { startWebHost } from '../../web/server.js';
import { ChatHub } from '../../src/chat/hub.js';
import { conversationFixture } from '../helpers/conversation.js';
import { uiFixture } from './fixture.js';

async function fits(page: Page) {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  const input = await page.getByLabel('消息', { exact: true }).boundingBox();
  const send = await page.getByRole('button', { name: '发送消息', exact: true }).boundingBox();
  const size = page.viewportSize()!;
  assert.ok(input && input.width > 200 && input.x >= 0 && input.y + input.height <= size.height);
  assert.ok(send && send.x >= 0 && send.x + send.width <= size.width && send.y + send.height <= size.height);
}

test('aurora theme keeps pairing, narrow controls and embedded history usable', { timeout: 30_000 }, async () => {
  const f = conversationFixture(), sessionId = f.create(), hub = new ChatHub(f.service, f.config);
  const host = await startWebHost({ hub, rendererDirectory: resolve('dist/renderer') });
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const errors: string[] = [];
  await mkdir('docs/validation', { recursive: true });
  try {
    const page = await browser.newPage({ viewport: { width: 300, height: 720 } });
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(host.url);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    const input = page.getByLabel('一次性配对码');
    await input.fill('invalid-code');
    await page.getByRole('button', { name: '连接', exact: true }).click();
    await page.getByRole('status').filter({ hasText: '配对码无效或已过期' }).waitFor();
    await page.screenshot({ path: 'docs/validation/aurora-pairing-300.png' });
    await input.fill(host.issuePairingCode().code);
    await page.getByRole('button', { name: '连接', exact: true }).click();
    await page.getByLabel('消息', { exact: true }).waitFor();
    await fits(page);
    const draft = '保留输入：' + '很长的中文与路径 /nested/directory/'.repeat(15);
    await page.getByLabel('消息', { exact: true }).fill(draft);
    await fits(page);
    assert.equal(await page.locator('.composer-box').evaluate(el => getComputedStyle(el).outlineStyle), 'solid');
    await page.getByRole('button', { name: '收起会话列表', exact: true }).click();
    await page.getByRole('button', { name: '展开会话列表', exact: true }).click();
    assert.equal(await page.getByLabel('消息', { exact: true }).inputValue(), draft);
    await page.reload();
    await page.getByLabel('消息', { exact: true }).waitFor();
    assert.equal(await page.getByLabel('消息', { exact: true }).inputValue(), draft);
    await page.setViewportSize({ width: 1160, height: 800 });
    await page.getByLabel('消息', { exact: true }).fill('“理解，从看见关系开始。”这句话应该怎么理解？');
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await page.waitForFunction(() => !!document.querySelector('[data-status="running"]'));
    assert.equal(f.calls.length, 1);
    const answer = '理解一个概念，要看它与什么有关，以及它们如何相互影响。\n\n把学习与已有知识、练习和反馈联系起来，这个概念才逐渐变得具体。';
    await f.calls[0]!.emit(1, answer);
    f.calls[0]!.finish('completed', answer);
    await page.getByTestId('assistant-message').and(page.locator('[data-status="completed"]')).waitFor();
    await page.screenshot({ path: 'docs/validation/aurora-standalone.png' });
    await page.goto(host.issueHandoff(sessionId).url);
    await page.getByLabel('消息', { exact: true }).waitFor();
    assert.equal(await page.locator('.titlebar, .chat-header').count(), 0);
    assert.equal(await page.getByRole('navigation', { name: '历史对话' }).count(), 0);
    await page.getByText('思考过程', { exact: true }).click();
    assert.equal(await page.locator('.thinking').evaluate(el => (el as HTMLDetailsElement).open), true);
    for (const width of [300, 360, 440]) {
      await page.setViewportSize({ width, height: 720 });
      await page.getByLabel('消息', { exact: true }).fill('继续解释这一点');
      await fits(page);
      assert.equal(await page.getByRole('button', { name: '发送消息', exact: true }).isEnabled(), true);
      await page.waitForTimeout(160); // Capture the settled button color, not its 140ms transition.
      await page.screenshot({ path: `docs/validation/aurora-embedded-${width}.png` });
    }
    assert.equal(f.calls.length, 1);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await host.close(); hub.dispose(); await f.service.dispose(); }
});

test('aurora desktop panels retain controls, drafts and keyboard dismissal at minimum window size', async t => {
  const f = await uiFixture(t), { app, page } = await f.launch();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(720, 560));
  await page.getByLabel('消息', { exact: true }).fill('设置关闭后保留这条草稿');
  await page.getByRole('button', { name: /文件范围/ }).click();
  const panel = page.getByRole('region', { name: '文件范围设置' });
  await panel.waitFor();
  assert.equal(await panel.evaluate(el => el.scrollWidth <= el.clientWidth), true);
  const bounds = await panel.boundingBox();
  assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 720);
  await page.screenshot({ path: 'docs/validation/aurora-file-permissions.png' });
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('button', { name: /文件范围/ }).evaluate(el => el === document.activeElement), true);
  await page.getByRole('button', { name: 'MCP', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'MCP 连接' });
  await page.getByLabel('MCP 配置（JSON）').waitFor();
  assert.equal(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth), true);
  await page.getByLabel('MCP 配置（JSON）').fill('{ invalid');
  await page.getByRole('button', { name: '保存并连接', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'JSON 格式无效' }).waitFor();
  const save = await page.getByRole('button', { name: '保存并连接', exact: true }).boundingBox();
  const dialogBounds = await dialog.boundingBox();
  assert.ok(save && dialogBounds && save.y + save.height <= dialogBounds.y + dialogBounds.height);
  const errorBounds = await page.getByRole('alert').filter({ hasText: 'JSON 格式无效' }).boundingBox();
  assert.ok(errorBounds && errorBounds.y + errorBounds.height <= save.y);
  await page.screenshot({ path: 'docs/validation/aurora-mcp-config.png' });
  await page.keyboard.press('Escape');
  assert.equal(await page.getByLabel('消息', { exact: true }).inputValue(), '设置关闭后保留这条草稿');
  assert.equal(await page.getByRole('button', { name: 'MCP', exact: true }).evaluate(el => el === document.activeElement), true);
  assert.deepEqual(f.errors, []);
});

test('narrow paired browser keeps file permissions and MCP settings inside the viewport', async t => {
  const oldPort = process.env.DREAMEDGE_WEB_PORT; process.env.DREAMEDGE_WEB_PORT = '0';
  t.after(() => { if (oldPort === undefined) delete process.env.DREAMEDGE_WEB_PORT; else process.env.DREAMEDGE_WEB_PORT = oldPort; });
  const f = await uiFixture(t), { app } = await f.launch();
  const detail = await app.evaluate(async ({ Menu, dialog }) => new Promise<string>(resolve => {
    dialog.showMessageBox = (async (_window: unknown, options: { detail?: string }) => {
      resolve(options.detail ?? ''); return { response: 1, checkboxChecked: false };
    }) as typeof dialog.showMessageBox;
    Menu.getApplicationMenu()!.getMenuItemById('web-enable')!.click(undefined, undefined, {} as never);
  }));
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 300, height: 720 } });
    await page.goto(/地址：(http:\/\/127\.0\.0\.1:\d+)/.exec(detail)![1]!);
    await page.getByLabel('一次性配对码').fill(/一次性配对码：([^\n]+)/.exec(detail)![1]!);
    await page.getByRole('button', { name: '连接', exact: true }).click();
    await page.getByRole('button', { name: /文件范围/ }).click();
    const panel = page.getByRole('region', { name: '文件范围设置' });
    const bounds = await panel.boundingBox();
    assert.ok(bounds && bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= 300 && bounds.y + bounds.height <= 720);
    assert.equal(await panel.evaluate(el => el.scrollWidth <= el.clientWidth), true);
    await page.screenshot({ path: 'docs/validation/aurora-file-permissions-300.png' });
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'MCP', exact: true }).click();
    await page.getByLabel('MCP 配置（JSON）').fill('{ invalid');
    await page.getByRole('button', { name: '保存并连接', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'JSON 格式无效' }).waitFor();
    assert.equal(await page.getByRole('dialog').evaluate(el => el.scrollWidth <= el.clientWidth), true);
    await page.screenshot({ path: 'docs/validation/aurora-mcp-config-300.png' });
  } finally { await browser.close(); }
});
