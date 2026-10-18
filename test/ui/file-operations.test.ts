import assert from 'node:assert/strict';
import test from 'node:test';
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { uiFixture, send, completed } from './fixture.js';
import { toolReply } from '../helpers/tool-loop.js';
import { beginSse, chatChunk } from '../helpers/server.js';
const answer = (response: Parameters<typeof beginSse>[0]) => {
  beginSse(response); chatChunk(response, { role: 'assistant', content: '结构操作完成。' }); chatChunk(response, {}, 'stop'); response.end('data: [DONE]\n\n');
};

test('Electron shows trash versus permanent deletion in one batch and invokes the native trash adapter only after confirmation', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dreamedge-operations-ui-'))); const trash = join(root, 'test-trash'); await mkdir(trash);
  const a = join(root, 'trash.txt'); const b = join(root, 'permanent.txt'); await writeFile(a, 'a'); await writeFile(b, 'b');
  t.after(() => rm(root, { recursive: true, force: true })); let turn = 0;
  const f = await uiFixture(t, { tools: true, handler: response => ++turn % 2 === 1 ? toolReply(response, [
    { id: `trash-${turn}`, name: 'delete', args: { path: a } }, { id: `delete-${turn}`, name: 'delete', args: { path: b, permanent: true } },
  ]) : answer(response) });
  const { app, page } = await f.launch();
  await app.evaluate(({ shell }, trash) => { shell.trashItem = async path => {
    const fs = process.getBuiltinModule('fs') as typeof import('node:fs'); await fs.promises.rename(path, `${trash}/native-adapter-result`);
  }; }, trash);
  await send(page, '删除这两份验收文件'); await page.getByRole('button', { name: '允许本批操作' }).waitFor();
  const list = page.getByLabel('批量计划清单'); assert.match(await list.innerText(), /移到废纸篓/); assert.match(await list.innerText(), /永久删除/);
  assert.equal(await page.getByRole('button', { name: '允许本批操作' }).count(), 1);
  await list.locator('summary').nth(1).click(); assert.match(await list.innerText(), /不能从废纸篓恢复/);
  await page.getByRole('button', { name: '拒绝', exact: true }).click(); await completed(page, '结构操作完成。'); await access(a); await access(b);
  await send(page, '按明确清单执行删除'); await page.getByRole('button', { name: '允许本批操作' }).waitFor();
  await page.screenshot({ path: 'docs/validation/file-operations-2026-10-16.png' });
  await page.getByRole('button', { name: '允许本批操作' }).click();
  await completed(page, '结构操作完成。');
  await assert.rejects(access(a)); await assert.rejects(access(b)); assert.equal(await readFile(join(trash, 'native-adapter-result'), 'utf8'), 'a');
  await page.reload(); await page.getByText('结构操作完成。', { exact: true }).last().waitFor(); assert.equal(f.server.requests.length, 4);
  assert.equal(f.errors.length, 0);
});

test('Electron creates directories, copies and moves binary files through the registered host tools', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dreamedge-copy-ui-'))); const data = Buffer.from([0, 255, 9]);
  await writeFile(join(root, 'source.bin'), data); t.after(() => rm(root, { recursive: true, force: true })); let turn = 0;
  const f = await uiFixture(t, { tools: true, handler: response => {
    ++turn;
    if (turn === 1) toolReply(response, [{ id: 'mkdir', name: 'mkdir', args: { path: join(root, 'output') } }]);
    else if (turn === 2) toolReply(response, [{ id: 'copy', name: 'copy', args: { path: join(root, 'source.bin'), destination: join(root, 'output/copy.bin') } }]);
    else if (turn === 3) toolReply(response, [{ id: 'move', name: 'move', args: { path: join(root, 'output/copy.bin'), destination: join(root, 'output/moved.bin') } }]);
    else answer(response);
  } });
  const { page } = await f.launch(); await send(page, '执行目录、复制和移动验收'); await completed(page, '结构操作完成。');
  assert.deepEqual(await readFile(join(root, 'output/moved.bin')), data); await assert.rejects(access(join(root, 'output/copy.bin')));
  assert.equal(await page.getByRole('button', { name: /允许这一次|允许本批操作/ }).count(), 0);
  assert.deepEqual(await page.getByTestId('tool-card').evaluateAll(cards => cards.map(c => c.getAttribute('data-status'))), ['succeeded', 'succeeded', 'succeeded']);
  assert.equal(f.errors.length, 0);
});
