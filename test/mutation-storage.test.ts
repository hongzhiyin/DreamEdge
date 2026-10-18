import assert from 'node:assert/strict';
import test from 'node:test';
import { SqliteSessionStore } from '../src/index.js';
import { mutationFixture, mutationDecision } from './helpers/mutation-loop.js';
import { toolReply } from './helpers/tool-loop.js';
import { toolStoreFixture, toolConversation } from './helpers/tool-storage.js';
import { mutationDigest } from '../src/files/mutation-digest.js';

test('v3 migrates to current schema preserving native tool records and grants without creating approval authority', async t => {
  const f = await toolStoreFixture(t); const data = toolConversation(); f.store.save(data, null); f.store.close(); f.faults.exec('PRAGMA user_version = 3');
  assert.deepEqual(f.open().load(), [data]); assert.equal(f.faults.prepare('PRAGMA user_version').get()?.user_version, 9);
});
test('pending preview survives storage but restart cancels authorization and never reconstructs its private plan', async t => {
  const f = await mutationFixture(t, r => toolReply(r, [{ id: 'w', name: 'write', args: { path: 'new.txt', content: 'new' } }]));
  const handle = f.send(); const a = await f.approval(); const stored = f.store.load()[0]!;
  const isolated = new SqliteSessionStore(':memory:'); t.after(() => isolated.close()); isolated.save(stored, null);
  const { restoreSession } = await import('../src/conversation/recovery.js');
  const recovered = restoreSession(isolated.load()[0]!, Date.now, () => {});
  assert.equal(recovered.runs[0]!.toolCalls![0]!.status, 'interrupted'); assert.equal(recovered.runs[0]!.approvals![0]!.status, 'cancelled');
  assert.deepEqual(recovered.runs[0]!.toolCalls![0]!.preview, stored.runs[0]!.toolCalls![0]!.preview);
  handle.cancel(); await handle.done;
});
test('corrupt preview digests and altered approval plan references are rejected atomically', async t => {
  const f = await mutationFixture(t, r => toolReply(r, [{ id: 'w', name: 'write', args: { path: 'new.txt', content: 'new' } }]));
  const handle = f.send(); await f.approval(); const original = f.store.load()[0]!;
  for (const corrupt of [true, false]) {
    const value = structuredClone(original); value.session.version++;
    if (corrupt) (value.runs[0]!.toolCalls![0]!.preview! as import('../src/files/mutation-types.js').MutationPreview).patch = 'changed'; else value.runs[0]!.approvals![0]!.file!.planDigest = 'changed';
    assert.throws(() => f.store.save(value, original.session.version), { code: 'INVALID_DATA' });
  }
  assert.deepEqual(f.store.load()[0], original); handle.cancel(); await handle.done;
});
test('saved approval preview is immutable even if a replacement has a self-consistent new digest', async t => {
  const f = await mutationFixture(t, r => toolReply(r, [{ id: 'w', name: 'write', args: { path: 'new.txt', content: 'new' } }]));
  const handle = f.send(); await f.approval(); const original = f.store.load()[0]!; const modified = structuredClone(original); modified.session.version++;
  const preview = modified.runs[0]!.toolCalls![0]!.preview! as import('../src/files/mutation-types.js').MutationPreview; preview.patch = 'altered'; preview.planDigest = mutationDigest(preview);
  modified.runs[0]!.approvals![0]!.file!.planDigest = preview.planDigest;
  assert.throws(() => f.store.save(modified, original.session.version), { code: 'INVALID_DATA' }); handle.cancel(); await handle.done;
});
