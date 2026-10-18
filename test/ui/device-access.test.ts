import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, realpath, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { uiFixture, send, completed } from './fixture.js';
import { toolReply } from '../helpers/tool-loop.js';
import { beginSse, chatChunk } from '../helpers/server.js';
const answer = (response: Parameters<typeof beginSse>[0]) => {
  beginSse(response); chatChunk(response, { role: 'assistant', content: '账户文件场景完成。' }); chatChunk(response, {}, 'stop'); response.end('data: [DONE]\n\n');
};

test('account mode needs no chooser or native consent, survives new chats and restart, and ignores legacy opt-in settings', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dreamedge-account-ui-')));
  await writeFile(join(root, 'note.txt'), 'ordinary account data'); t.after(() => rm(root, { recursive: true, force: true })); let turn = 0;
  const f = await uiFixture(t, { tools: true, handler: response => ++turn % 2 === 1
    ? toolReply(response, [{ id: `r-${turn}`, name: 'read', args: { path: join(root, 'note.txt') } }]) : answer(response) });
  await writeFile(join(f.profile, 'file-access.local.json'), '{old invalid opt-in settings}');
  let current = await f.launch();
  await current.app.evaluate(({ dialog }) => {
    dialog.showMessageBox = (async () => { throw new Error('Unexpected consent'); }) as typeof dialog.showMessageBox;
    dialog.showOpenDialog = (async () => { throw new Error('Unexpected chooser'); }) as typeof dialog.showOpenDialog;
  });
  await send(current.page, '读取任意目录中的普通文件'); await completed(current.page, '账户文件场景完成。');
  assert.match(await current.page.getByTestId('tool-card').innerText(), /ordinary account data/);
  await current.page.getByRole('button', { name: /新对话/ }).click();
  await send(current.page, '新对话无需设置'); await completed(current.page, '账户文件场景完成。');
  await current.app.close(); current = await f.launch(); await current.page.getByTestId('tool-card').waitFor();
  await send(current.page, '恢复后继续读取'); await completed(current.page, '账户文件场景完成。');
  assert.match(await current.page.getByRole('button', { name: /^文件范围/ }).innerText(), /账户权限/);
  assert.equal(f.server.requests.length, 6); assert.equal(f.errors.length, 0);
});

test('account mode automatically creates ordinary files and excludes credentials without leaking to the provider', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dreamedge-account-write-')));
  await writeFile(join(root, 'credentials.json'), 'excluded fixture text'); t.after(() => rm(root, { recursive: true, force: true })); let turn = 0;
  const f = await uiFixture(t, { tools: true, handler: response => {
    if (++turn === 1) { toolReply(response, [{ id: 'r', name: 'read', args: { path: join(root, 'credentials.json') } }]); return; }
    if (turn === 3) { toolReply(response, [{ id: 'w', name: 'write', args: { path: join(root, 'new.txt'), content: 'automatic creation' } }]); return; }
    answer(response);
  } });
  const { page } = await f.launch();
  await send(page, '读取凭据'); await completed(page, '账户文件场景完成。');
  assert.doesNotMatch(JSON.stringify(f.server.requests), /excluded fixture text/);
  await send(page, '创建普通文件'); await completed(page, '账户文件场景完成。');
  assert.equal(await readFile(join(root, 'new.txt'), 'utf8'), 'automatic creation');
  const card = page.getByTestId('tool-card').last(); assert.match(await card.innerText(), /自动检查通过/);
  assert.equal(await card.getByRole('button', { name: '允许这一次' }).count(), 0); assert.equal(f.errors.length, 0);
});
