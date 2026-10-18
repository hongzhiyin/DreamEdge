import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { uiFixture, send, completed } from './fixture.js';
import { toolReply } from '../helpers/tool-loop.js';
import { beginSse, chatChunk } from '../helpers/server.js';

test('sensitive overwrite needs conversation approval, survives renderer reload, and stop prevents modification', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dreamedge-account-mutation-'))); const path = join(root, 'note.txt');
  await writeFile(path, 'original'); t.after(() => rm(root, { recursive: true, force: true })); let turn = 0;
  const f = await uiFixture(t, { tools: true, handler: response => {
    const n = ++turn % 3;
    if (n === 1) { toolReply(response, [{ id: `r-${turn}`, name: 'read', args: { path } }]); return; }
    if (n === 2) { toolReply(response, [{ id: `w-${turn}`, name: 'write', args: { path, content: `changed-${turn}` } }]); return; }
    beginSse(response); chatChunk(response, { role: 'assistant', content: '变更已处理。' }); chatChunk(response, {}, 'stop'); response.end('data: [DONE]\n\n');
  } });
  let current = await f.launch(); await send(current.page, '整体覆盖文件');
  let card = current.page.getByTestId('tool-card').last(); await card.getByRole('button', { name: '允许这一次' }).waitFor();
  assert.equal(await readFile(path, 'utf8'), 'original'); assert.match(await card.innerText(), /敏感操作.*整体覆盖/s);
  await current.page.reload(); card = current.page.getByTestId('tool-card').last();
  await card.getByRole('button', { name: '允许这一次' }).click(); await completed(current.page, '变更已处理。');
  assert.equal(await readFile(path, 'utf8'), 'changed-2');
  await current.app.close(); current = await f.launch(); await current.page.getByText('变更已处理。', { exact: true }).waitFor();
  assert.equal(f.server.requests.length, 3);
  await send(current.page, '停止另一笔覆盖'); card = current.page.getByTestId('tool-card').last();
  await card.getByRole('button', { name: '允许这一次' }).waitFor();
  await current.page.getByRole('button', { name: '停止生成' }).click();
  await current.page.locator('[data-testid="assistant-message"][data-status="cancelled"]').last().waitFor();
  assert.equal(await readFile(path, 'utf8'), 'changed-2'); assert.equal(f.errors.length, 0);
});
