import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { uiFixture, send, completed } from './fixture.js';
import { mcpHttpFixture } from '../helpers/mcp-http.js';
import { toolReply } from '../helpers/tool-loop.js';
import { chatReply } from '../helpers/server.js';
import { mcpToolAlias } from '../../src/index.js';

test('production desktop web host exposes paired MCP controls, approvals and client revocation', { timeout: 30000 }, async t => {
  const old = process.env.DREAMEDGE_WEB_PORT; process.env.DREAMEDGE_WEB_PORT = '0';
  t.after(() => { if (old === undefined) delete process.env.DREAMEDGE_WEB_PORT; else process.env.DREAMEDGE_WEB_PORT = old; });
  const mcp = await mcpHttpFixture(t);
  const f = await uiFixture(t, { tools: true, handler: (res, request) => {
    if (!(request.body.messages as { role: string }[]).some(m => m.role === 'tool')) {
      toolReply(res, [{ id: 'web-mcp-call', name: mcpToolAlias('web-app', 'first'), args: {} }]);
    } else chatReply(res);
  } });
  const { app } = await f.launch();
  const detail = await app.evaluate(async ({ Menu, dialog }) => new Promise<string>(resolve => {
    dialog.showMessageBox = (async (_window: unknown, options: { detail?: string }) => {
      resolve(options.detail ?? ''); return { response: 1, checkboxChecked: false };
    }) as typeof dialog.showMessageBox;
    Menu.getApplicationMenu()!.getMenuItemById('web-enable')!.click(undefined, undefined, {} as never);
  }));
  const url = /地址：(http:\/\/127\.0\.0\.1:\d+)/.exec(detail)![1]!;
  const code = /一次性配对码：([^\n]+)/.exec(detail)![1]!;
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 420, height: 900 } }); page.setDefaultTimeout(8000);
    await page.goto(url); await page.getByLabel('一次性配对码').fill(code);
    await page.getByRole('button', { name: '连接', exact: true }).click();
    await page.getByRole('button', { name: 'MCP', exact: true }).click();
    await page.getByLabel('或选择 JSON 文件').setInputFiles({ name: 'mcp.json', mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({ mcpServers: { 'web-app': { url: mcp.url } } })) });
    await page.getByRole('button', { name: '保存并连接', exact: true }).click();
    await page.getByText('已连接', { exact: true }).waitFor();
    await page.getByRole('button', { name: '关闭 MCP' }).click(); await send(page, '调用网页 MCP 工具');
    await page.getByRole('button', { name: '允许这一次' }).waitFor();
    assert.equal(mcp.requests.filter(r => r.rpc === 'tools/call').length, 0);
    await page.getByRole('button', { name: '允许这一次' }).click(); await completed(page, 'Hello world');
    assert.equal(mcp.requests.filter(r => r.rpc === 'tools/call').length, 1);
    await app.evaluate(({ Menu }) => Menu.getApplicationMenu()!.getMenuItemById('web-revoke')!.click(undefined, undefined, {} as never));
    await page.getByLabel('一次性配对码').waitFor(); assert.deepEqual(f.errors, []);
  } finally { await browser.close(); }
});
