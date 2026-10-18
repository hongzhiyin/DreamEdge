import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { resolve, dirname, join } from 'node:path';
import { startWebHost } from '../../web/server.js';
import { ChatHub } from '../../src/chat/hub.js';
import { ReaderStore } from '../../src/reading/store.js';
import { legacyReadingAdapter } from '../../src/adapters/recollection-garden/legacy.js';
import { modelDestination } from '../../src/model/destination.js';
import { McpControl, mcpControlHandler } from '../../src/mcp/control.js';
import { lifecycleFixture } from '../helpers/mcp-connection.js';
import { toolLoopFixture } from '../helpers/tool-loop.js';
import { chatReply } from '../helpers/server.js';

test('paired narrow web UI migrates legacy bindings through generic MCP controls and keeps local history', { timeout: 30000 }, async t => {
  const f = await toolLoopFixture(t, response => chatReply(response)); await f.send('旧对话内容').done;
  const directory = dirname(f.path);
  new ReaderStore(join(directory, 'reading.local.json')).bind(f.sessionId, { readerSessionId: 'window', bookId: 'book', title: 'Old book', destination: modelDestination(f.config), selectedNotes: [] });
  const mcp = await lifecycleFixture(t);
  const control = new McpControl(mcp.registry, mcp.manager, () => f.service, () => f.config, [legacyReadingAdapter(directory)]);
  const hub = new ChatHub(f.service, f.config);
  const host = await startWebHost({ hub, rendererDirectory: resolve('dist/renderer'), extensions: { mcp: mcpControlHandler(control) } });
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 420, height: 900 } }); page.setDefaultTimeout(5000);
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(host.url); await page.getByLabel('一次性配对码').fill(host.issuePairingCode().code);
    await page.getByRole('button', { name: '连接', exact: true }).click();
    await page.getByText('旧对话内容', { exact: true }).last().waitFor();
    assert.equal(await page.getByRole('button', { name: '阅读器', exact: true }).count(), 0);
    await page.getByRole('button', { name: 'MCP · 1', exact: true }).click();
    await page.getByText('高级', { exact: true }).click();
    await page.getByText(/此会话保留旧阅读器记录/).waitFor();
    await page.getByRole('button', { name: '连接', exact: true }).click();
    await page.getByText('已连接', { exact: true }).waitFor();
    assert.equal(await page.locator('dialog').evaluate(element => element.scrollWidth <= element.clientWidth), true);
    await page.screenshot({ path: '/tmp/dreamedge-mcp-stage6-web.png', fullPage: true });
    await page.getByRole('button', { name: '关闭 MCP' }).click(); await page.reload();
    await page.getByRole('button', { name: 'MCP · 1', exact: true }).click();
    await page.getByText('已连接', { exact: true }).waitFor();
    await page.getByText('详情', { exact: true }).click();
    await page.getByRole('button', { name: '撤销连接授权' }).click();
    await page.getByText('已停用', { exact: true }).waitFor();
    assert.equal(control.mode(f.sessionId), 'external'); assert.throws(() => control.select(f.sessionId));
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await host.close(); hub.dispose(); }
});
