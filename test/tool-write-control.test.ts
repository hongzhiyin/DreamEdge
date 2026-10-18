import assert from 'node:assert/strict';
import test from 'node:test';
import { approvalFixture } from './helpers/tool-approval.js';
import { chatReply, deadline } from './helpers/server.js';
import { waitUntil } from './helpers/storage.js';

for (const scenario of ['stop', 'timeout', 'throw'] as const) {
  test(`write ${scenario} records an unknown outcome and blocks blind retry`, async t => {
    let actions = 0; let release!: () => void; let aborted = false;
    const f = await approvalFixture(t, async signal => {
      actions++;
      if (scenario === 'throw') throw new Error('private fixture error');
      signal.addEventListener('abort', () => { aborted = true; });
      await new Promise<void>(resolve => { release = resolve; }); return 'late';
    }, {}, scenario === 'timeout' ? 40 : 1000);
    const handle = f.send(); f.service.decideApproval(await f.approval());
    await waitUntil(() => actions === 1); if (scenario === 'stop') handle.cancel();
    const result = await deadline(handle.done, 5000);
    assert.equal(result.status, scenario === 'stop' ? 'cancelled' : 'failed');
    assert.equal(result.toolCalls![0]!.status, 'outcome_unknown');
    if (scenario !== 'throw') { assert.equal(aborted, true); release(); }
    assert.equal(f.server.requests.length, 1); assert.equal(f.service.getSnapshot(f.sessionId).saveState.status, 'saved');
    assert.throws(() => f.service.retry(f.sessionId, handle.runId), { code: 'RETRY_UNAVAILABLE' });
    assert.throws(() => f.service.retry(f.sessionId, handle.runId, 'read_tools'), { code: 'RETRY_UNAVAILABLE' });
    await Promise.resolve(); await Promise.resolve();
    assert.deepEqual(f.service.getSnapshot(f.sessionId).runs[0], result); assert.equal(actions, 1);
  });
}

test('write result save-only retry releases continuation without repeating the approved action', async t => {
  let actions = 0; const f = await approvalFixture(t, async () => { actions++; return 'ok'; });
  const handle = f.send(); const command = await f.approval();
  f.faults.exec(`CREATE TRIGGER deny_result BEFORE INSERT ON run_messages
    WHEN json_extract(NEW.record, '$.message.role') = 'toolResult' BEGIN SELECT RAISE(ABORT, 'fixture'); END`);
  f.service.decideApproval(command); await waitUntil(() => f.service.getSnapshot(f.sessionId).saveState.status === 'failed');
  assert.equal(actions, 1); assert.equal(f.server.requests.length, 1);
  f.faults.exec('DROP TRIGGER deny_result'); f.service.retrySave(f.sessionId);
  assert.equal((await deadline(handle.done, 5000)).status, 'completed'); assert.equal(actions, 1);
});

for (const mode of ['continue', 'read_tools'] as const) {
  test(`retry ${mode} preserves a completed write without exposing write tools again`, async t => {
    let actions = 0; let continuations = 0;
    const f = await approvalFixture(t, async () => { actions++; return 'ok'; }, {}, 1000, 'write', response => {
      if (++continuations === 1) { response.writeHead(500); response.end('fixture failure'); }
      else chatReply(response);
    });
    const handle = f.send(); f.service.decideApproval(await f.approval());
    const original = await deadline(handle.done, 5000); assert.equal(original.status, 'failed');
    assert.equal(original.toolCalls![0]!.status, 'succeeded');
    const result = await deadline(f.service.retry(f.sessionId, handle.runId, mode).done, 5000);
    assert.equal(result.status, 'completed', result.error?.message); assert.equal(actions, 1);
    const request = f.server.requests.at(-1)!.body;
    assert.ok(!request.tools || (request.tools as unknown[]).length === 0);
    const messages = request.messages as { role: string; content: string }[];
    assert.equal(messages.filter(message => message.role === 'user').length, 1);
    assert.equal(messages.find(message => message.role === 'tool')!.content, 'ok');
  });
}
