import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm, realpath, readdir, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { uiFixture, send, completed } from './fixture.js';
import { toolReply } from '../helpers/tool-loop.js';
import { beginSse, chatChunk } from '../helpers/server.js';

test('Electron reads and searches through packaged Pi tools, restores provenance and cleans worker caches', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dreamedge-ui-read-root-')));
  await writeFile(join(root, 'note.txt'), 'desktop file needle\n'); t.after(() => rm(root, { recursive: true, force: true }));
  let turn = 0;
  const f = await uiFixture(t, { tools: true, handler: response => {
    if (++turn === 1) { toolReply(response, [
      { id: 'list', name: 'ls', args: { path: root } }, { id: 'find', name: 'find', args: { path: root, pattern: '*.txt' } },
      { id: 'search', name: 'grep', args: { path: root, pattern: 'needle' } }, { id: 'read', name: 'read', args: { path: join(root, 'note.txt') } },
    ]); return; }
    beginSse(response); chatChunk(response, { role: 'assistant', content: '文件操作已完成。' }); chatChunk(response, {}, 'stop'); response.end('data: [DONE]\n\n');
  } });
  const { app, page } = await f.launch();
  await app.evaluate(({ dialog }, root) => { dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [root] })) as typeof dialog.showOpenDialog; }, root);
  const s = await page.evaluate(async () => (await window.dreamedge.initialize()).sessions[0]!);
  assert.equal(await page.getByRole('button', { name: '选择目录', exact: true }).count(), 0);
  await send(page, '读取并查找文件'); await completed(page, '文件操作已完成。');
  const view = await page.evaluate(async id => (await window.dreamedge.watch(id)).kind === 'snapshot'
    ? ((await window.dreamedge.watch(id)) as { kind: 'snapshot'; event: { view: import('../../src/chat/types.js').ChatView } }).event.view : undefined, s.sessionId);
  const cards = view!.messages[0]!.attempts[0]!.timeline!.filter(item => item.kind === 'tool');
  assert.equal(cards.length, 4); assert.deepEqual(cards.map(item => item.call.status), Array(4).fill('succeeded'));
  assert.match(JSON.stringify(cards), /desktop file needle/); assert.doesNotMatch(JSON.stringify(cards), /dreamedge-file-snapshot-/);
  assert.deepEqual(await readdir(join(f.profile, 'file-snapshots')), []);
  await app.close(); const orphan = join(f.profile, 'file-snapshots', 'dreamedge-file-snapshot-orphan');
  await mkdir(orphan, { mode: 0o700 }); await writeFile(join(orphan, 'fixture'), 'orphaned test data');
  const restored = await f.launch();
  assert.deepEqual(await readdir(join(f.profile, 'file-snapshots')), []);
  await restored.page.getByText('文件操作已完成。', { exact: true }).waitFor();
  const after = await restored.page.evaluate(async id => (await window.dreamedge.fileScopes!(id)).observations, s.sessionId);
  assert.equal(after.length, 2); assert.equal(f.server.requests.length, 2);
  await send(restored.page, '继续说明'); await completed(restored.page, '文件操作已完成。');
  assert.equal(f.server.requests.length, 3); assert.match(JSON.stringify(f.server.requests.at(-1)!.body.messages), /desktop file needle/);
  assert.equal(f.errors.length, 0);
});
