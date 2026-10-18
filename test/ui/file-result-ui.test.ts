import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, realpath, rm, writeFile, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { uiFixture, send, completed } from './fixture.js';
import { toolReply } from '../helpers/tool-loop.js';
import { beginSse, chatChunk } from '../helpers/server.js';

test('file cards show Pi windows, limits, full expandable text, empty search and failure; reload preserves results', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dreamedge-file-results-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'note.txt'), 'first\nsecond needle\nthird needle\nfourth\n');
  await writeFile(join(root, 'long.txt'), Array.from({ length: 300 }, (_, i) => `${i + 1}: ${'abcdefghij'.repeat(10)}`).join('\n') + '\nEND-OF-RESULT');
  await writeFile(join(root, 'limited.txt'), Array.from({ length: 2500 }, (_, i) => `row ${i + 1}`).join('\n'));
  let turn = 0;
  const f = await uiFixture(t, { tools: true, handler: response => {
    if (++turn === 1) { toolReply(response, [
      { id: 'window', name: 'read', args: { path: join(root, 'note.txt'), offset: 2, limit: 2 } },
      { id: 'empty', name: 'find', args: { path: root, pattern: '*.missing' } },
      { id: 'match', name: 'grep', args: { path: join(root, 'note.txt'), pattern: 'needle', limit: 1 } },
      { id: 'list', name: 'ls', args: { path: root, limit: 1 } },
      { id: 'long', name: 'read', args: { path: join(root, 'long.txt') } },
      { id: 'limited', name: 'read', args: { path: join(root, 'limited.txt') } },
      { id: 'failed', name: 'read', args: { path: join(root, '.env') } },
    ]); return; }
    beginSse(response); chatChunk(response, { role: 'assistant', content: '文件结果验证完成。' }); chatChunk(response, {}, 'stop'); response.end('data: [DONE]\n\n');
  } });
  const { app, page } = await f.launch();
  await send(page, '检查文件结果'); await completed(page, '文件结果验证完成。');
  const cards = page.getByTestId('tool-card'); assert.equal(await cards.count(), 7);
  const window = cards.filter({ has: page.locator('.file-result-path', { hasText: '/note.txt' }) }).first();
  assert.match(await window.innerText(), /请求窗口：第 2 行起，最多 2 行/); assert.match(await window.innerText(), /部分读取/);
  assert.match(await window.innerText(), /second needle\nthird needle/);
  assert.match(await cards.filter({ hasText: '匹配项达到 1 项上限' }).innerText(), /结果可能不完整/);
  assert.equal(await cards.filter({ hasText: '目录项达到 1 项上限' }).count(), 1);
  assert.equal(await cards.filter({ hasText: '工具输出已截断' }).count(), 1);
  assert.equal(await cards.locator('.tool-output').filter({ hasText: 'No files found' }).count(), 1);
  const long = cards.filter({ has: page.locator('.file-result-path', { hasText: '/long.txt' }) });
  await long.getByRole('button', { name: '展开完整结果' }).click(); assert.match(await long.locator('.tool-output').innerText(), /END-OF-RESULT/);
  assert.equal(await cards.locator('[role="status"]').count(), 1);
  assert.doesNotMatch((await cards.allTextContents()).join(), /dreamedge-file-snapshot-/);
  await page.screenshot({ path: 'docs/validation/file-results-2026-10-15.png' });
  await page.reload(); await page.getByText('文件结果验证完成。', { exact: true }).waitFor();
  assert.equal(await page.getByTestId('tool-card').count(), 7); assert.equal(f.server.requests.length, 2); assert.equal(f.errors.length, 0);
});
