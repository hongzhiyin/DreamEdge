import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { uiFixture, send, completed } from './fixture.js';
import { toolReply } from '../helpers/tool-loop.js';
import { chatReply } from '../helpers/server.js';
import { mcpToolAlias } from '../../src/index.js';

test('desktop MCP configuration, trust, selection, tool confirmation and restart use the generic host', { timeout: 45000 }, async t => {
  const alias = mcpToolAlias('generic-app', 'fixture_action');
  const f = await uiFixture(t, { tools: true, handler: (response, request) => {
    if (!(request.body.messages as { role: string }[]).some(m => m.role === 'tool')) toolReply(response, [{ id: 'mcp-call', name: alias, args: {} }]);
    else chatReply(response);
  } });
  let { app, page } = await f.launch();
  await page.getByRole('button', { name: 'MCP', exact: true }).click();
  await page.getByLabel('MCP 配置（JSON）').fill(JSON.stringify({ mcpServers: { 'generic-app': {
    command: process.execPath, args: [resolve('dist/test/fixtures/mcp-service.js')],
  } } }));
  await page.getByRole('button', { name: '保存并连接', exact: true }).click();
  await page.getByText('已连接', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('连接标识', { exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: '批准此配置' }).count(), 0);
  await page.getByText('详情', { exact: true }).click(); await page.getByText(/fixture_action/).waitFor();
  await page.getByRole('button', { name: '关闭 MCP' }).click();
  assert.equal(await page.getByRole('button', { name: /文件范围/ }).count(), 0);
  await send(page, '调用外部工具'); await page.getByRole('button', { name: '允许这一次' }).waitFor();
  assert.match(await page.getByTestId('tool-card').innerText(), /generic-app/);
  await page.getByRole('button', { name: '允许这一次' }).click(); await completed(page, 'Hello world');
  await app.close(); ({ app, page } = await f.launch());
  await page.getByRole('button', { name: 'MCP · 1', exact: true }).click();
  await page.getByText('就绪，调用时连接', { exact: true }).waitFor();
  await page.getByText('详情', { exact: true }).click();
  await page.getByRole('button', { name: '撤销连接授权' }).click();
  await page.getByText('已停用', { exact: true }).waitFor();
  await page.getByRole('button', { name: '关闭 MCP' }).click();
  assert.equal(await page.getByRole('button', { name: /文件范围/ }).count(), 0);
  assert.deepEqual(f.errors, []);
});
