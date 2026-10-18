import assert from 'node:assert/strict';
import test from 'node:test';
import { scopeFixture } from './helpers/file-scopes.js';
import { ChatHub } from '../src/chat/hub.js';
import type { ChatCatchup, ChatToolCall } from '../src/chat/types.js';
import { connection } from './helpers/server.js';
import { fileResultView } from '../src/chat/file-result.js';

test('chat snapshots publish scope changes with current destination without identities or observation history', async t => {
  const f = await scopeFixture(t); const hub = new ChatHub(f.service, connection('http://127.0.0.1:1')); t.after(() => hub.dispose());
  const command = { type: 'watch', sessionId: f.session.sessionId };
  const snapshot = () => {
    const reply = hub.execute(command); assert.ok(reply.ok); const data = reply.data as ChatCatchup;
    assert.equal(data.kind, 'snapshot'); return data.kind === 'snapshot' ? data.event : undefined!;
  };
  const first = snapshot(); assert.equal(first.view.fileScope?.grants.length, 0);
  const grant = await f.choose({ mode: 'read', remember: true, excludes: ['private'] });
  const current = snapshot(); assert.ok(current.sequence > first.sequence);
  assert.equal(current.view.fileScope?.grants[0]?.path, f.root);
  assert.doesNotMatch(JSON.stringify(current.view.fileScope), /identity|rootId|observations|credentialRef/);
  current.view.fileScope!.grants[0]!.excludes.push('mutated consumer');
  assert.deepEqual(snapshot().view.fileScope?.grants[0]?.excludes, ['private']);
  f.changeModel(); assert.equal(snapshot().view.fileScope?.destination.model, 'new-model');
  assert.notEqual(snapshot().view.fileScope?.destination.model, grant!.destination.model);
  f.service.fileScopes.revoke(f.session.sessionId, grant!.grantId);
  assert.notEqual(snapshot().view.fileScope?.grants[0]?.revokedAt, undefined);
});

const call = (overrides: Partial<ChatToolCall> = {}): ChatToolCall => ({ toolCallId: 'file', label: '读取文件', name: 'read',
  version: 'pi-1.1.0/scoped-read-1', status: 'succeeded', effect: 'read', args: { path: 'file.txt', offset: 3, limit: 2 }, resources: [],
  result: { content: [{ type: 'text', text: 'partial content' }], details: { fileAccess: {
    path: '/authorized/file.txt', destination: { model: 'model', baseUrl: 'https://api.example.test/' },
    entries: 1, bytes: 12, skipped: 0, files: [{ complete: false }] } } }, ...overrides });
test('file result view distinguishes requested windows and partial reads from whole-file evidence', () => {
  const view = fileResultView(call())!; assert.equal(view.path, '/authorized/file.txt');
  assert.equal(view.window, '请求窗口：第 3 行起，最多 2 行'); assert.match(view.notices.join(), /部分读取/);
  assert.equal(view.destination, 'model · https://api.example.test/'); assert.equal(view.bytes, 12);
  assert.equal(fileResultView(call({ version: 'unscoped-native' })), undefined);
});
test('Pi truncation, match and line limits are displayed without turning incomplete results into complete ones', () => {
  const view = fileResultView(call({ name: 'grep', result: { content: [{ type: 'text', text: 'match' }],
    details: { truncation: { truncated: true }, matchLimitReached: 1, linesTruncated: true } } }))!;
  assert.equal(view.notices.length, 3); assert.match(view.notices.join(), /截断.*1 项上限.*匹配行已截断/);
  assert.equal(view.window, undefined);
});
test('file receipt communicates publication separately from subsequent version verification', () => {
  for (const verified of [true, false]) {
    const view = fileResultView(call({ name: 'write', effect: 'write', version: 'pi-1.1.0/scoped-mutation-1',
      result: { content: [{ type: 'text', text: 'saved' }], details: { fileMutation: { commit: 'confirmed', verified } } } }))!;
    assert.match(view.mutation!, verified ? /已写入并核对/ : /核对未完成/);
  }
  assert.equal(fileResultView(call({ result: { content: [], details: { fileAccess: { entries: -1, bytes: 'unknown' } } } }))!.bytes, undefined);
});
