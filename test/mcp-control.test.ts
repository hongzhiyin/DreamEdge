import assert from 'node:assert/strict';
import test from 'node:test';
import { McpControl, mcpControlHandler } from '../src/mcp/control.js';
import { lifecycleFixture } from './helpers/mcp-connection.js';
import { toolLoopFixture } from './helpers/tool-loop.js';
import { chatReply } from './helpers/server.js';
import { legacyReadingAdapter } from '../src/adapters/recollection-garden/legacy.js';
import { ReaderStore } from '../src/reading/store.js';
import { modelDestination } from '../src/model/destination.js';
import { dirname, join } from 'node:path';
import { readerVersion } from '../src/reading/protocol.js';
import { builtInTools } from '../src/tools/builtins.js';

async function fixture(t: Parameters<typeof lifecycleFixture>[0]) {
  const mcp = await lifecycleFixture(t), chat = await toolLoopFixture(t, response => chatReply(response));
  const control = new McpControl(mcp.registry, mcp.manager, () => chat.service, () => chat.config);
  const command = (type: string, fields = {}) => control.request({ type, sessionId: chat.sessionId, ...fields });
  return { ...mcp, ...chat, mcp, control, command };
}
test('generic controls separate configuration, trust, selection and actual connection', async t => {
  const f = await fixture(t);
  assert.equal(f.control.mode(f.sessionId), 'local'); assert.equal(f.mcp.messages.length, 0);
  await assert.rejects(f.command('pin', { identity: f.ref }));
  await f.command('approve', { identity: f.ref }); assert.equal(f.mcp.messages.length, 0);
  await f.command('pin', { identity: f.ref }); assert.equal(f.control.mode(f.sessionId), 'external');
  assert.deepEqual(f.control.select(f.sessionId), [f.ref]); assert.equal(f.mcp.messages.length, 0);
  const view = await f.command('connect', { identity: f.ref }); assert.equal(view.servers[0]!.connection?.state, 'ready');
  await f.command('revoke', { identity: f.ref });
  assert.equal(f.control.mode(f.sessionId), 'external'); assert.throws(() => f.control.select(f.sessionId), /不会回退/);
});

test('editing invalidates trust and stale UI actions cannot touch the new version', async t => {
  const f = await fixture(t); await f.command('approve', { identity: f.ref }); await f.command('pin', { identity: f.ref });
  const changed = await f.command('update', { identity: f.ref, patch: { displayName: 'Renamed generic app' } });
  assert.equal(changed.servers[0]!.approval, undefined); assert.throws(() => f.control.select(f.sessionId));
  await assert.rejects(f.command('approve', { identity: f.ref }));
  await assert.rejects(f.command('disconnect', { identity: f.ref }));
  const next = changed.servers[0]!.identity; await f.command('approve', { identity: next }); await f.command('pin', { identity: next });
  assert.deepEqual(f.control.select(f.sessionId), [next]);
});

test('context provenance is assigned by host and resolution does not automatically select a server', async t => {
  const f = await fixture(t);
  await assert.rejects(f.command('context', { context: { appId: 'app.generic', source: 'host-window' } }));
  await f.command('associate', { identity: f.ref, scope: { appId: 'app.generic' } });
  const view = await f.command('context', { context: { appId: 'app.generic', windowRef: 'window-2', resourceRef: 'doc-2' } });
  assert.equal(view.context?.source, 'user-selection'); assert.equal(view.resolution?.kind, 'selected');
  assert.equal(view.binding, undefined); assert.deepEqual(f.control.select(f.sessionId), []); assert.equal(f.mcp.messages.length, 0);
});

test('control rejects arbitrary execution, unknown fields and foreign sessions without leaking configuration', async t => {
  const f = await fixture(t), handler = mcpControlHandler(f.control);
  for (const command of [{ type: 'callTool', sessionId: f.sessionId, name: 'any' },
    { type: 'snapshot', sessionId: f.sessionId, config: {} }, { type: 'snapshot', sessionId: 'missing' }]) {
    assert.equal((await handler(command)).ok, false);
  }
  assert.equal(f.mcp.messages.length, 0);
});

test('legacy migration adapter preserves history recipient restriction and never creates MCP trust', async t => {
  const f = await fixture(t), directory = dirname(f.path);
  new ReaderStore(join(directory, 'reading.local.json')).bind(f.sessionId, { readerSessionId: 'legacy-window', bookId: 'legacy-book',
    title: 'Saved title', destination: modelDestination(f.config), selectedNotes: [] });
  const adapter = legacyReadingAdapter(directory);
  const control = new McpControl(f.mcp.registry, f.manager, () => f.service, () => f.config, [adapter]);
  assert.equal(control.mode(f.sessionId), 'migration'); assert.throws(() => control.select(f.sessionId));
  assert.equal(f.mcp.registry.snapshot().servers[0]!.approval, undefined);
  const run = { modelConfigSnapshot: f.config, toolsSnapshot: [{ ...builtInTools().snapshots()[0]!, version: readerVersion }] } as never;
  adapter.guardHistory([run], f.config);
  assert.throws(() => adapter.guardHistory([run], { ...f.config, model: 'another-model' }), /原模型/);
  assert.equal(f.mcp.messages.length, 0);
});

test('legacy external history protection survives uninstalling a business adapter', async t => {
  const f = await fixture(t);
  const { guardExternalHistory } = await import('../src/conversation/external-history.js');
  const run = { modelConfigSnapshot: f.config, toolsSnapshot: [{ ...builtInTools().snapshots()[0]!, resources: ['generic-external-service'] }] } as never;
  guardExternalHistory([run], f.config, f.config);
  assert.throws(() => guardExternalHistory([run], { ...f.config, model: 'different' }, f.config), /原模型/);
});
