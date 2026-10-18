import assert from 'node:assert/strict';
import test from 'node:test';
import { Type } from 'typebox';
import { ConversationService, PiRuntime, SqliteSessionStore, ToolRegistry } from '../src/index.js';
import { approvalFixture } from './helpers/tool-approval.js';
import { toolLoopFixture, toolReply } from './helpers/tool-loop.js';
import { chatReply, deadline } from './helpers/server.js';
import { waitUntil } from './helpers/storage.js';

test('an old approval cannot release a new run even when the same tool and arguments are used', async t => {
  let actions = 0; const f = await approvalFixture(t, async () => { actions++; return 'ok'; });
  const first = f.send(); const stale = await f.approval(); first.cancel(); await first.done;
  const second = f.service.send({ sessionId: f.sessionId, clientMessageId: 'two', text: 'New operation' });
  const current = await f.approval();
  assert.throws(() => f.service.decideApproval(stale), { code: 'STALE_RUN' }); assert.equal(actions, 0);
  f.service.decideApproval(current); assert.equal((await second.done).status, 'completed'); assert.equal(actions, 1);
});

test('restart invalidates a persisted pending approval and does not dispatch any action', async t => {
  let actions = 0; const f = await approvalFixture(t, async () => { actions++; return 'ok'; });
  const handle = f.send(); const stale = await f.approval();
  const store = new SqliteSessionStore(f.path);
  const reopened = new ConversationService({ store, connection: () => f.config, tools: () => f.registry.snapshots(),
    runtime: config => new PiRuntime(config, async () => 'fixture-key', { registry: f.registry }) });
  const recovered = reopened.getSnapshot(f.sessionId).runs[0]!;
  assert.equal(recovered.status, 'interrupted'); assert.equal(recovered.approvals![0]!.status, 'cancelled');
  assert.equal(actions, 0); assert.equal(f.server.requests.length, 1);
  assert.throws(() => reopened.decideApproval(stale), { code: 'STALE_RUN' });
  handle.cancel(); await handle.done; await reopened.dispose();
});

test('invalid parameters are rejected before an authorization request is created', async t => {
  let actions = 0; const registry = new ToolRegistry();
  registry.register({ name: 'fixture', version: '1', label: 'fixture', description: 'fixture',
    parameters: Type.Object({ value: Type.Number() }, { additionalProperties: false }), effect: 'write', approval: 'always',
    resources: ['fixture'], timeoutMs: 1000, async execute() { actions++; return { content: [] }; } });
  const f = await toolLoopFixture(t, (response, request) => {
    if ((request.body.messages as { role: string }[]).at(-1)?.role === 'tool') chatReply(response);
    else toolReply(response, [{ id: 'bad', name: 'fixture', args: { value: 'bad' } }]);
  }, registry);
  const result = await f.send().done; assert.equal(result.status, 'completed');
  assert.equal(result.approvals!.length, 0); assert.equal(actions, 0);
});

test('explicit read-tools retry permits a fresh read after failure and keeps prior results in context', async t => {
  let actions = 0; let requests = 0; const registry = new ToolRegistry();
  registry.register({ name: 'fixture', version: '1', label: 'fixture', description: 'fixture',
    parameters: Type.Object({}, { additionalProperties: false }), effect: 'read', approval: 'never', resources: [], timeoutMs: 1000,
    async execute() { if (++actions === 1) throw new Error('fixture'); return { content: [{ type: 'text', text: 'ok' }] }; } });
  const f = await toolLoopFixture(t, response => {
    requests++;
    if (requests === 2) { response.writeHead(500); response.end('fixture'); }
    else if (requests === 1 || requests === 3) toolReply(response, [{ id: `call-${requests}`, name: 'fixture', args: {} }]);
    else chatReply(response);
  }, registry);
  const original = await f.send().done; assert.equal(original.status, 'failed');
  const result = await deadline(f.service.retry(f.sessionId, original.runId, 'read_tools').done, 5000);
  assert.equal(result.status, 'completed', result.error?.message); assert.equal(actions, 2);
  assert.equal((f.server.requests[2]!.body.tools as unknown[]).length, 1);
  assert.equal((f.server.requests[3]!.body.messages as { role: string }[]).filter(message => message.role === 'tool').length, 2);
});

test('approved read-tool cancellation has a known cancelled outcome and does not require write reconciliation', async t => {
  let started = false;
  const f = await approvalFixture(t, async signal => {
    started = true; await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
    return 'late';
  }, {}, 1000, 'read');
  const handle = f.send(); f.service.decideApproval(await f.approval()); await waitUntil(() => started);
  handle.cancel(); const result = await handle.done; assert.equal(result.toolCalls![0]!.status, 'cancelled');
  assert.equal(f.service.getSnapshot(f.sessionId).saveState.status, 'saved');
});
