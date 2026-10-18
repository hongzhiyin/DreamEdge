import assert from 'node:assert/strict';
import test from 'node:test';
import { mcpRunFixture } from './helpers/mcp-run.js';
import { deadline } from './helpers/server.js';
import { waitUntil } from './helpers/storage.js';
import { SqliteSessionStore } from '../src/index.js';
import { validateStored } from '../src/storage/validation.js';
const resource = async (uri: string) => ({ contents: [{ uri, text: 'private fixture resource' }] });

async function complete(f: Awaited<ReturnType<typeof mcpRunFixture>>) {
  const h = f.send(); await f.decide(); assert.equal((await deadline(h.done, 5000)).status, 'completed');
}

test('MCP histories remain readable locally but cannot be resent after revocation or recipient changes', async t => {
  for (const change of ['revoke', 'model', 'endpoint', 'config', 'disconnect'] as const) {
    const f = await mcpRunFixture(t, { resource }); await complete(f);
    const saved = f.store.load()[0]!.runs[0]!; const requests = f.server.requests.length;
    if (change === 'revoke') f.registry.revoke(f.ref);
    if (change === 'model') f.config.model = 'other-model';
    if (change === 'endpoint') f.config.baseUrl = f.server.baseUrl + '/other';
    if (change === 'config') f.registry.update(f.ref, { displayName: 'new configuration' });
    if (change === 'disconnect') await f.manager.disconnect(f.sessionId, f.ref.serverId);
    const h = f.service.send({ sessionId: f.sessionId, clientMessageId: 'follow', text: 'Summarize the previous answer' });
    const next = await deadline(h.done, 5000); assert.equal(next.error?.code, 'INVALID_CONTEXT');
    assert.equal(f.server.requests.length, requests); assert.equal(f.reads(), 1);
    assert.deepEqual(f.store.load()[0]!.runs[0], saved);
  }
});

test('authorization is rechecked after resource response and before model continuation', async t => {
  let revoke!: () => void;
  const f = await mcpRunFixture(t, { resource: async uri => { revoke(); return resource(uri); } });
  revoke = () => f.registry.revoke(f.ref);
  const h = f.send(); await f.decide(); const result = await deadline(h.done, 5000);
  assert.notEqual(result.toolCalls![0]!.status, 'succeeded'); assert.equal(f.server.requests.length, 1);
  assert.ok(!JSON.stringify(result).includes('private fixture resource'));
});

test('restored completed MCP results can continue without rereading; missing host guard fails closed', async t => {
  const f = await mcpRunFixture(t, { resource }); await complete(f); const data = f.store.load()[0]!;
  const restored = f.restore(data); const before = f.server.requests.length;
  const h = restored.send({ sessionId: f.sessionId, clientMessageId: 'follow', text: 'Summarize' });
  assert.equal((await deadline(h.done, 5000)).status, 'completed'); assert.equal(f.reads(), 1);
  assert.equal(f.server.requests.length, before + 1);
  const unguarded = f.restore(data, false);
  const denied = await deadline(unguarded.send({ sessionId: f.sessionId, clientMessageId: 'follow2', text: 'Summarize' }).done, 5000);
  assert.equal(denied.error?.code, 'INVALID_CONTEXT'); assert.equal(f.server.requests.length, before + 1);
});

test('restart cancels pending MCP approvals without inheriting their execution grant', async t => {
  const f = await mcpRunFixture(t, { resource }); const h = f.send(); const pending = await f.pending();
  const data = f.store.load()[0]!; h.cancel(); await h.done;
  const restored = f.restore(data); const snapshot = restored.getSnapshot(f.sessionId);
  assert.equal(snapshot.runs[0]!.status, 'interrupted'); assert.equal(snapshot.runs[0]!.approvals![0]!.status, 'cancelled');
  assert.equal(snapshot.runs[0]!.toolCalls![0]!.status, 'interrupted'); assert.equal(f.reads(), 0);
  assert.throws(() => restored.decideApproval({ ...pending, decision: 'approve' }));
  const continued = await deadline(restored.retry(f.sessionId).done, 5000);
  assert.equal(continued.status, 'completed'); assert.equal(f.reads(), 0);
});

test('restart distinguishes in-flight MCP reads from unknown writes and never replays either', async t => {
  for (const kind of ['read', 'write'] as const) {
    const f = await mcpRunFixture(t, kind === 'read' ? { resource: () => new Promise(() => {}) }
      : { operation: () => new Promise(() => {}) });
    const h = f.send(); await f.decide(); await waitUntil(() => (kind === 'read' ? f.reads() : f.actions()) === 1);
    const data = f.store.load()[0]!; h.cancel(); await h.done;
    const restored = f.restore(data); const run = restored.getSnapshot(f.sessionId).runs[0]!;
    assert.equal(run.status, 'interrupted'); assert.equal(run.toolCalls![0]!.status, kind === 'read' ? 'interrupted' : 'outcome_unknown');
    assert.equal(kind === 'read' ? f.reads() : f.actions(), 1);
    if (kind === 'write') assert.throws(() => restored.retry(f.sessionId), /未知/);
    else { assert.equal((await deadline(restored.retry(f.sessionId).done, 5000)).status, 'completed'); assert.equal(f.reads(), 1); }
  }
});

test('resource receipts reject corrupted content, destination, URI and service provenance', async t => {
  const f = await mcpRunFixture(t, { resource }); await complete(f);
  const saved = f.store.load()[0]!;
  for (const field of ['uri', 'contentDigest', 'destination', 'origin'] as const) {
    const data = structuredClone(saved); const message = data.runs[0]!.transcript!.find(e => e.message.role === 'toolResult')!.message;
    if (message.role !== 'toolResult') throw 0;
    const receipt = (message.details as { mcpResource: Record<string, unknown> }).mcpResource;
    receipt[field] = 'corrupted'; assert.throws(() => validateStored(data));
  }
});

test('v8 MCP tool history migrates to v9 unchanged; mislabeled resource records roll back', async t => {
  const tools = await mcpRunFixture(t); await complete(tools); const before = tools.store.load();
  tools.faults.exec('PRAGMA user_version = 8'); const next = new SqliteSessionStore(tools.path);
  try { assert.deepEqual(next.load(), before); assert.equal(tools.faults.prepare('PRAGMA user_version').get()!.user_version, 9); }
  finally { next.close(); }
  const resources = await mcpRunFixture(t, { resource }); await complete(resources);
  resources.faults.exec('PRAGMA user_version = 8'); assert.throws(() => new SqliteSessionStore(resources.path));
  assert.equal(resources.faults.prepare('PRAGMA user_version').get()!.user_version, 8);
  resources.faults.exec('PRAGMA user_version = 9');
});

test('restart during capability preparation retains the question and performs no connection or model request', async t => {
  let release!: () => void;
  const f = await mcpRunFixture(t, { select: () => new Promise<void>(resolve => { release = resolve; }) });
  const h = f.send(); await waitUntil(() => !!release); const data = f.store.load()[0]!;
  h.cancel(); await h.done; release(); const restored = f.restore(data);
  assert.equal(restored.getSnapshot(f.sessionId).runs[0]!.status, 'interrupted');
  assert.equal(f.server.requests.length, 0); assert.equal(f.messages.length, 0);
  const continued = await deadline(restored.retry(f.sessionId).done, 5000);
  assert.equal(continued.status, 'completed'); assert.equal(f.messages.length, 0);
});
