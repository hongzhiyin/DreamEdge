import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReaderService } from '../src/reading/service.js';
import { ReaderStore } from '../src/reading/store.js';
import { ReadingExecution } from '../src/reading/execution.js';
import { ReaderCli } from '../src/reading/cli-client.js';
import { FixtureReader } from './helpers/reader.js';
import { toolLoopFixture } from './helpers/tool-loop.js';
import { chatReply } from './helpers/server.js';

test('binding is explicit, persists by chat and rejects stale book, unselected note and direct write', async t => {
  const f = await toolLoopFixture(t, response => chatReply(response)), client = new FixtureReader();
  const path = join(tmpdir(), `reader-${f.sessionId}.json`); t.after(() => rm(path, { force: true }));
  const store = new ReaderStore(path), reader = new ReaderService(client, store, id => f.service.getSnapshot(id), () => f.config);
  const execution = new ReadingExecution(reader);
  const ctx = { sessionId: f.sessionId, runId: 'forged', turnId: 'turn', toolCallId: 'call', signal: new AbortController().signal };
  await assert.rejects(reader.live(f.sessionId, ctx.signal), /绑定/);
  await assert.rejects(reader.ui({ type: 'bind', chatId: f.sessionId, readerSessionId: 'wrong', bookId: 'book' }), /变化/);
  await reader.ui({ type: 'bind', chatId: f.sessionId, readerSessionId: 'window', bookId: 'book' });
  assert.equal(new ReaderStore(path).binding(f.sessionId)?.bookId, 'book');
  await assert.rejects(execution.execute('reader_navigate', { page: 2 }, ctx), /批准/);
  assert.equal(client.calls.some(c => c.operation === 'reader.navigate'), false);
  await assert.rejects(execution.execute('reader_note_get', { noteId: 'note' }, ctx), /选择/);
  await reader.ui({ type: 'selectNote', chatId: f.sessionId, noteId: 'note' });
  await execution.execute('reader_note_get', { noteId: 'note' }, ctx);
  client.session.contextVersion = 'v2';
  await execution.execute('reader_page', { page: 96 }, ctx);
  assert.equal(client.calls.at(-1)?.input.contextVersion, 'v2');
  client.session.bookId = 'another';
  await assert.rejects(reader.live(f.sessionId, ctx.signal), /变化/);
  await reader.ui({ type: 'unbind', chatId: f.sessionId });
  assert.equal(reader.enabled(f.sessionId), false);
});

test('CLI output preserves Chinese split across UTF-8 byte boundaries', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dreamedge-reader-cli-'));
  try {
    const path = join(directory, 'fixture');
    await writeFile(path, `#!/usr/bin/env node\nprocess.stdin.resume();process.stdin.on('end',()=>{const bytes=Buffer.from(JSON.stringify({ok:true,data:{title:'中文验收'}}));const cut=bytes.indexOf(Buffer.from('中'))+1;process.stdout.write(bytes.subarray(0,cut));setTimeout(()=>process.stdout.end(bytes.subarray(cut)),20);});\n`, { mode: 0o700 });
    const result = await new ReaderCli(process.execPath, [path]).call('sessions.list', { requestId: 'fixture', params: {} }, new AbortController().signal);
    assert.deepEqual(result, { ok: true, data: { title: '中文验收' } });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
