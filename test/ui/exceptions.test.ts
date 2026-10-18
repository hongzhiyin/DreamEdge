import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import test from 'node:test';
import { uiFixture, send, completed } from './fixture.js';
import { waitUntil } from '../helpers/storage.js';
import { deadline } from '../helpers/server.js';

test('Electron exception and concurrency boundaries', async t => {
  const f = await uiFixture(t); let current = await f.launch();
  await t.test('parallel identical IPC sends create only one model request and question', async () => {
    const before = f.server.requests.length;
    const ids = await current.page.evaluate(async () => {
      const input = { sessionId: sessionStorage.getItem('dreamedge:selected')!, clientMessageId: crypto.randomUUID(), text: '重复提交' };
      return Promise.all(Array.from({ length: 20 }, () => window.dreamedge.send(input)));
    });
    await completed(current.page, '重复提交');
    assert.equal(new Set(ids.map(id => id.runId)).size, 1);
    assert.equal(await current.page.getByTestId('user-message').filter({ hasText: '重复提交' }).count(), 1);
    assert.equal(f.server.requests.length, before + 1);
  });
  await t.test('network disconnection exposes the partial reply and manual retry succeeds', async () => {
    await send(current.page, '网络中断');
    await current.page.locator('[data-status="failed"]').filter({ hasText: '中断前片段' }).waitFor();
    await current.page.getByRole('button', { name: '重试', exact: true }).click();
    await completed(current.page, '网络中断');
    assert.equal(await current.page.getByTestId('user-message').filter({ hasText: '网络中断' }).count(), 1);
  });
  await t.test('incomplete protocol and output-limit replies are failed rather than completed history', async () => {
    for (const question of ['协议不完整', '长度上限']) {
      await send(current.page, question);
      await current.page.locator('[data-status="failed"]').filter({ hasText: '不完整片段' }).last().waitFor();
    }
    await send(current.page, '失败后的新问题'); await completed(current.page, '失败后的新问题');
    const wire = f.server.requests.at(-1)!.body.messages as { content: string }[];
    assert.ok(!wire.some(message => message.content.includes('不完整片段')));
  });
  await t.test('stale stop and retry commands cannot affect a newer generation', async () => {
    const old = await current.page.evaluate(async () => {
      const id = sessionStorage.getItem('dreamedge:selected')!;
      const reply = await window.dreamedge.watch(id);
      return { sessionId: id, runId: reply.kind === 'snapshot' ? reply.event.view.messages.at(-1)!.attempts.at(-1)!.runId : '' };
    });
    await send(current.page, '连续输出');
    await current.page.getByTestId('assistant-message').last().filter({ hasText: '开头。' }).waitFor();
    const rejected = await current.page.evaluate(async target => {
      const result = [];
      for (const action of [window.dreamedge.stop, window.dreamedge.retry]) {
        try { await action(target.sessionId, target.runId); result.push(false); } catch { result.push(true); }
      }
      return result;
    }, old);
    assert.deepEqual(rejected, [true, true]);
    f.append('仍在运行。'); f.finish(); await completed(current.page, '仍在运行');
  });
  await t.test('failed quit preserves the window and saving recovery permits further conversation', async () => {
    const db = new DatabaseSync(join(f.profile, 'sessions.sqlite'));
    try {
      db.exec(`CREATE TRIGGER fail_quit BEFORE UPDATE ON runs WHEN NEW.status = 'completed'
        AND NEW.user_message_id IN (SELECT message_id FROM messages WHERE json_extract(record, '$.content') = '退出保存失败')
        BEGIN SELECT RAISE(ABORT, 'fixture write failure'); END`);
      await send(current.page, '退出保存失败');
      try { await completed(current.page, '退出保存失败'); }
      catch (error) {
        const diagnostic = await current.page.evaluate(async () => window.dreamedge.watch(sessionStorage.getItem('dreamedge:selected')!));
        const event = diagnostic.kind === 'snapshot' ? diagnostic.event : diagnostic.events.at(-1);
        process.stderr.write(`Quit failure diagnostic: ${JSON.stringify({ attempt: event?.view.messages.at(-1)?.attempts.at(-1), saving: event?.view.saving })}\n`);
        throw error;
      }
      await current.page.getByRole('button', { name: '重试保存' }).waitFor();
      await current.app.evaluate(({ app }) => { app.quit(); });
      await current.page.waitForFunction(async () => {
        const reply = await window.dreamedge.watch(sessionStorage.getItem('dreamedge:selected')!);
        return reply.kind === 'snapshot' && reply.event.view.acceptingCommands;
      });
      db.exec('DROP TRIGGER fail_quit');
      await current.page.getByRole('button', { name: '重试保存' }).click();
      await current.page.getByText('已保存', { exact: true }).waitFor();
      await send(current.page, '退出失败恢复后继续'); await completed(current.page, '退出失败恢复后继续');
    } finally { db.exec('DROP TRIGGER IF EXISTS fail_quit'); db.close(); }
  });
  await t.test('whole-process crash restores the checkpoint as interrupted and never auto-resends', async () => {
    await send(current.page, '连续输出');
    await current.page.getByTestId('assistant-message').last().filter({ hasText: '开头。' }).waitFor();
    f.append('崩溃前确认。');
    const db = new DatabaseSync(join(f.profile, 'sessions.sqlite'));
    await waitUntil(() => String(db.prepare('SELECT record FROM runs ORDER BY rowid DESC LIMIT 1').get()?.record).includes('崩溃前确认'));
    db.close();
    const count = f.server.requests.length;
    const stopped = new Promise<void>(resolve => current.app.once('close', () => resolve()));
    current.app.process().kill('SIGKILL'); await deadline(stopped, 5000);
    current = await f.launch();
    await current.page.locator('[data-status="interrupted"]').filter({ hasText: '崩溃前确认' }).waitFor();
    assert.equal(f.server.requests.length, count);
    await send(current.page, '中断后继续'); await completed(current.page, '中断后继续');
    const wire = f.server.requests.at(-1)!.body.messages as { content: string }[];
    assert.ok(!wire.some(message => message.content.includes('崩溃前确认')));
  });
  await t.test('renderer crash recovers the same main-process generation without resending', async () => {
    await send(current.page, '连续输出');
    await current.page.getByTestId('assistant-message').last().filter({ hasText: '开头。' }).waitFor();
    const count = f.server.requests.length;
    const loaded = current.app.evaluate(({ BrowserWindow }) => new Promise<void>(resolve => {
      BrowserWindow.getAllWindows()[0]!.webContents.once('did-finish-load', () => resolve());
    }));
    await current.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.forcefullyCrashRenderer());
    await deadline(loaded, 5000);
    let ready = false;
    for (let i = 0; i < 100 && !ready; i++) {
      ready = await current.app.evaluate(async ({ BrowserWindow }) => {
        try { return Boolean(await BrowserWindow.getAllWindows()[0]!.webContents.executeJavaScript(`Boolean(document.querySelector('#chat-input'))`)); }
        catch { return false; }
      });
      if (!ready) await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(ready, true);
    f.append('渲染恢复后完成。'); f.finish();
    let recovered = false;
    for (let i = 0; i < 100 && !recovered; i++) {
      recovered = await current.app.evaluate(async ({ BrowserWindow }) => Boolean(await BrowserWindow.getAllWindows()[0]!
        .webContents.executeJavaScript(`document.querySelector('[data-testid="assistant-message"][data-status="completed"]:last-child')
          && [...document.querySelectorAll('[data-testid="assistant-message"]')].at(-1)?.textContent.includes('渲染恢复后完成')`)));
      if (!recovered) await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(recovered, true); assert.equal(f.server.requests.length, count);
  });
});

test('Electron request timeout', async t => {
  const f = await uiFixture(t, { timeoutMs: 300 }); const { page } = await f.launch();
  await send(page, '请求超时');
  await page.locator('[data-status="failed"]').filter({ hasText: '模型请求超时' }).waitFor();
  await send(page, '超时后继续'); await completed(page, '超时后继续');
});
