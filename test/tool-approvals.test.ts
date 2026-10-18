import assert from 'node:assert/strict';
import test from 'node:test';
import { ChatHub } from '../src/chat/hub.js';
import { approvalFixture } from './helpers/tool-approval.js';
import { deadline } from './helpers/server.js';
import { waitUntil } from './helpers/storage.js';

test('one-shot approval persists its receipt and intent before exactly one isolated callback', async t => {
  let actions = 0;
  const f = await approvalFixture(t, async () => {
    const saved = f.store.load()[0]!.runs[0]!;
    assert.equal(saved.approvals![0]!.status, 'approved'); assert.equal(saved.toolCalls![0]!.status, 'running');
    actions++; return 'ok';
  });
  const handle = f.send(); const command = await f.approval();
  assert.equal((f.server.requests[0]!.body.tools as unknown[]).length, 1);
  assert.equal(actions, 0); assert.equal(f.store.load()[0]!.runs[0]!.approvals![0]!.status, 'pending');
  f.service.decideApproval(command); f.service.decideApproval(command);
  assert.throws(() => f.service.decideApproval({ ...command, decision: 'reject' }), { code: 'STALE_RUN' });
  const result = await deadline(handle.done, 5000);
  assert.equal(result.status, 'completed', result.error?.message); assert.equal(actions, 1);
  assert.equal(result.toolCalls![0]!.status, 'succeeded');
  assert.throws(() => f.service.decideApproval(command), { code: 'STALE_RUN' });
});

test('every approval identity field rejects a changed or stale target', async t => {
  let actions = 0; const f = await approvalFixture(t, async () => { actions++; return 'ok'; });
  const handle = f.send(); const command = await f.approval();
  for (const key of ['runId', 'turnId', 'toolCallId', 'toolName', 'toolVersion', 'argsDigest', 'approvalId'] as const) {
    assert.throws(() => f.service.decideApproval({ ...command, [key]: 'different' }), { code: 'STALE_RUN' });
  }
  const other = f.service.createSession({ connectionId: f.config.id });
  assert.throws(() => f.service.decideApproval({ ...command, sessionId: other.sessionId }), { code: 'STALE_RUN' });
  assert.equal(actions, 0); f.service.decideApproval({ ...command, decision: 'reject' }); await handle.done;
});

for (const action of ['reject', 'expire', 'stop'] as const) {
  test(`approval ${action} closes the wait without executing the tool`, async t => {
    let actions = 0; const f = await approvalFixture(t, async () => { actions++; return 'ok'; },
      action === 'expire' ? { approvalTtlMs: 60 } : {});
    const handle = f.send(); const command = await f.approval();
    if (action === 'reject') f.service.decideApproval({ ...command, decision: 'reject' });
    if (action === 'stop') f.service.stop(f.sessionId, handle.runId);
    const result = await deadline(handle.done, 5000);
    assert.equal(actions, 0); assert.equal(result.approvals![0]!.status,
      action === 'stop' ? 'cancelled' : action === 'expire' ? 'expired' : 'rejected');
    assert.equal(result.toolCalls![0]!.status, action === 'stop' ? 'cancelled' : 'rejected');
    if (action === 'stop') assert.equal(f.server.requests.length, 1);
    assert.throws(() => f.service.decideApproval(command), { code: 'STALE_RUN' });
  });
}

test('failed authorization commit cannot invoke a tool; save retry releases the same approved call once', async t => {
  let actions = 0; const f = await approvalFixture(t, async () => { actions++; return 'ok'; });
  const handle = f.send(); const command = await f.approval();
  f.faults.exec(`CREATE TRIGGER deny_grant BEFORE UPDATE ON tool_calls WHEN NEW.status = 'running'
    BEGIN SELECT RAISE(ABORT, 'fixture'); END`);
  f.service.decideApproval(command);
  await waitUntil(() => f.service.getSnapshot(f.sessionId).saveState.status === 'failed');
  assert.equal(actions, 0); assert.equal(f.store.load()[0]!.runs[0]!.approvals![0]!.status, 'pending');
  assert.throws(() => f.service.decideApproval(command), { code: 'SAVE_FAILED' });
  f.faults.exec('DROP TRIGGER deny_grant'); f.service.retrySave(f.sessionId);
  assert.equal((await deadline(handle.done, 5000)).status, 'completed'); assert.equal(actions, 1);
});

test('stopping while an approved intent cannot save prevents execution after save-only retry', async t => {
  let actions = 0; const f = await approvalFixture(t, async () => { actions++; return 'ok'; });
  const handle = f.send(); const command = await f.approval();
  f.faults.exec(`CREATE TRIGGER deny_grant BEFORE UPDATE ON tool_calls WHEN NEW.status = 'running'
    BEGIN SELECT RAISE(ABORT, 'fixture'); END`);
  f.service.decideApproval(command); await waitUntil(() => f.service.getSnapshot(f.sessionId).saveState.status === 'failed');
  handle.cancel(); await deadline(handle.done, 5000); f.faults.exec('DROP TRIGGER deny_grant');
  f.service.retrySave(f.sessionId); assert.equal(actions, 0);
  assert.equal(f.service.getSnapshot(f.sessionId).saveState.status, 'saved');
});

test('chat IPC projects approval metadata and validates the decision envelope', async t => {
  const f = await approvalFixture(t, async () => 'ok'); const hub = new ChatHub(f.service, f.config);
  t.after(() => hub.dispose()); const handle = f.send(); const command = await f.approval();
  const view = hub.execute({ type: 'watch', sessionId: f.sessionId });
  assert.ok(view.ok); assert.ok(JSON.stringify(view).includes(command.approvalId));
  for (const decision of [{ ...command, decision: 'allow_all' }, { ...command, args: {} }, { ...command, runId: '' }]) {
    const reply = hub.execute({ type: 'approval', decision }); assert.ok(!reply.ok); assert.equal(reply.error.code, 'INVALID_COMMAND');
  }
  assert.ok(hub.execute({ type: 'approval', decision: command }).ok); assert.equal((await handle.done).status, 'completed');
});
