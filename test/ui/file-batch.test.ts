import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, realpath, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { uiFixture, send, completed } from './fixture.js';
import { toolReply } from '../helpers/tool-loop.js';
import { beginSse, chatChunk } from '../helpers/server.js';

for (const restart of [false, true]) {
  test(`batch chat shows one decision, complete diffs and ${restart ? 'explicit recovery after stop and restart' : 'renderer reload without duplicate operations'}`, async t => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'dreamedge-batch-ui-')));
    const paths = ['a.txt', 'b.txt', 'c.txt'].map(name => join(root, name));
    for (const path of paths) await writeFile(path, 'original'); t.after(() => rm(root, { recursive: true, force: true }));
    let turn = 0;
    const f = await uiFixture(t, { tools: true, handler: response => {
      ++turn;
      if (turn === 1 || (restart && turn === 3)) { toolReply(response, paths.map((path, i) => ({ id: `r${i}-${turn}`, name: 'read', args: { path } }))); return; }
      if (turn === 2 || (restart && turn === 4)) { toolReply(response, paths.map((path, i) => ({ id: `w${i}-${turn}`, name: 'write', args: { path, content: `updated ${i}` } }))); return; }
      beginSse(response); chatChunk(response, { role: 'assistant', content: '批次已处理。' }); chatChunk(response, {}, 'stop'); response.end('data: [DONE]\n\n');
    } });
    let current = await f.launch(); await send(current.page, '批量覆盖这三份文档');
    await current.page.getByRole('button', { name: '允许本批操作', exact: true }).waitFor();
    assert.equal(await current.page.getByRole('button', { name: '允许本批操作' }).count(), 1);
    assert.equal(await current.page.getByRole('button', { name: '允许这一次' }).count(), 0);
    const list = current.page.getByLabel('批量计划清单'); assert.equal(await list.locator('details').count(), 3);
    await list.locator('summary').nth(1).click(); assert.match(await list.locator('details').nth(1).innerText(), /updated 1/);
    for (const path of paths) assert.equal(await readFile(path, 'utf8'), 'original');
    if (restart) {
      await current.page.getByRole('button', { name: '停止生成' }).click();
      await current.page.getByRole('button', { name: '准备恢复未完成项', exact: true }).waitFor();
      await current.app.close(); current = await f.launch();
      await current.page.getByRole('button', { name: '准备恢复未完成项', exact: true }).waitFor();
      assert.equal(f.server.requests.length, 2);
      await current.page.getByRole('button', { name: '准备恢复未完成项', exact: true }).click();
    } else await current.page.reload();
    await current.page.getByRole('button', { name: '允许本批操作', exact: true }).waitFor();
    for (const path of paths) assert.equal(await readFile(path, 'utf8'), 'original');
    if (!restart) await current.page.screenshot({ path: 'docs/validation/file-batch-2026-10-16.png' });
    await current.page.getByRole('button', { name: '允许本批操作', exact: true }).click();
    await completed(current.page, '批次已处理。');
    for (const [i, path] of paths.entries()) assert.equal(await readFile(path, 'utf8'), `updated ${i}`);
    assert.match(await current.page.getByLabel('批量计划清单').last().innerText(), /已完成 3／3/);
    assert.equal(await current.page.getByRole('button', { name: '准备恢复未完成项', exact: true }).count(), 0);
    assert.equal(f.server.requests.length, restart ? 5 : 3); assert.equal(f.errors.length, 0);
  });
}
