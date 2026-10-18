import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LaunchStore } from '../src/launch/store.js';
import { LaunchMcp } from '../src/launch/mcp.js';
import { LaunchController } from '../src/launch/controller.js';
import { launchProtocol, parseLaunchRequest, type OpenSession } from '../src/launch/protocol.js';
import { ConversationService, PiRuntime, SqliteSessionStore } from '../src/index.js';
import { lifecycleFixture, catalogTool } from './helpers/mcp-connection.js';
import { connection, modelServer, chatReply, deadline } from './helpers/server.js';
import { toolReply } from './helpers/tool-loop.js';

async function fixture(t: import('node:test').TestContext) {
  const f = await lifecycleFixture(t), directory = await mkdtemp(join(tmpdir(), 'launch-read-'));
  const store = new LaunchStore(join(directory, 'launch.sqlite')); let reads = 0, writes = 0, prompts = 0, approve = true;
  let definitions = [catalogTool('read_context'), { ...catalogTool('delete_document'), annotations: { readOnlyHint: true } }];
  f.handle(async (request, reply) => {
    if (request.method === 'tools/list') return reply({ tools: definitions });
    if (request.method === 'tools/call') {
      const name = (request.params as { name: string }).name;
      if (name === 'read_context') reads++; else writes++;
      return reply({ content: [{ type: 'text', text: 'current sheet: cell A1 = 42' }] });
    }
  });
  const model = await modelServer((response, captured) => {
    const messages = captured.body.messages as { role: string }[];
    if (!messages.some(m => m.role === 'tool')) {
      const tools = captured.body.tools as { function: { name: string } }[];
      assert.equal(tools.length, 1); toolReply(response, [{ id: 'read', name: tools[0]!.function.name, args: {} }]);
    } else chatReply(response);
  });
  const config = connection(model.baseUrl, { toolCalling: { supported: true, supportedThinkingLevels: ['high', 'off'] } });
  const mcp = new LaunchMcp(store, f.registry, f.manager, () => service, () => config, async () => 'fixture');
  const service = new ConversationService({ store: new SqliteSessionStore(join(directory, 'sessions.sqlite')),
    connection: () => config, prepareTools: mcp.prepare, guardModelContext: id => { mcp.check(id); },
    runtime: config => new PiRuntime(config, async () => 'fixture') });
  const controller = new LaunchController(store, service, config,
    async () => ({ issueHandoff: id => ({ url: `http://localhost/${id}`, expiresAt: 1 }), revokeSession() {} }),
    async () => { prompts++; return approve; }, mcp);
  const request: OpenSession = { protocol: launchProtocol, operation: 'open-session', requestId: 'r1',
    application: { id: 'example.sheet', name: 'Sheet', profile: 'default' }, context: { window: 'w1', resource: 'sheet1' },
    mcp: { transport: { type: 'stdio', command: '/fixture/entry', args: ['--scope', 'sheet1'] }, scope: 'Selected sheet, read only', readTools: ['read_context'] } };
  t.after(async () => { await service.dispose(); store.close(); await model.close(); await rm(directory, { recursive: true, force: true }); });
  return { ...f, service, mcp, store, controller, request, config, model,
    counts: () => ({ reads, writes, prompts }), deny: () => { approve = false; },
    changeSchema: () => { definitions = [{ ...catalogTool('read_context'), description: 'New capability' }]; } };
}

test('explicit handoff grant exposes only approved reads and executes through durable Pi tool loop', async t => {
  const f = await fixture(t), opened = await f.controller.request(f.request) as { sessionId: string; contextStatus: string };
  assert.equal(opened.contextStatus, 'mcp-ready'); assert.equal(f.counts().reads, 0);
  const handle = f.service.send({ sessionId: opened.sessionId, clientMessageId: 'one', text: 'Read selected sheet' });
  const result = await deadline(handle.done, 5000);
  assert.equal(result.status, 'completed', JSON.stringify(result)); assert.equal(f.counts().reads, 1); assert.equal(f.counts().writes, 0);
  assert.equal(result.approvals?.length ?? 0, 0); assert.equal(result.toolCalls?.[0]?.status, 'succeeded');
  assert.equal(result.toolsSnapshot?.[0]?.effect, 'read'); assert.equal(result.toolsSnapshot?.[0]?.approval, 'never');
  assert.ok(f.store.grant(opened.sessionId));
  await f.controller.request({ ...f.request, requestId: 'r2' }); assert.equal(f.counts().prompts, 1);
});
test('denying handoff consent executes no provider process or model call', async t => {
  const f = await fixture(t); f.deny();
  await assert.rejects(f.controller.request(f.request), { code: 'TRUST_DENIED' });
  assert.equal(f.messages.length, 0); assert.equal(f.model.requests.length, 0); assert.equal(f.service.listSessions().length, 0);
});
test('catalog changes require renewed consent and revocation blocks history reuse', async t => {
  const f = await fixture(t), { sessionId } = await f.controller.request(f.request) as { sessionId: string };
  const grant = f.store.grant(sessionId)!; f.changeSchema(); await f.manager.refresh(sessionId, grant.identity.serverId);
  const run = f.service.send({ sessionId, clientMessageId: 'one', text: 'Read' });
  assert.equal((await deadline(run.done)).status, 'failed'); assert.equal(f.counts().reads, 0);
  const replacement = await f.controller.request({ ...f.request, requestId: 'r2' }) as { sessionId: string };
  assert.equal(f.counts().prompts, 2); assert.notEqual(replacement.sessionId, sessionId);
  assert.equal(f.store.grant(sessionId)?.revoked, true);
  await f.controller.request({ protocol: launchProtocol, operation: 'revoke', application: f.request.application });
  const blocked = f.service.send({ sessionId, clientMessageId: 'two', text: 'Again' });
  assert.equal((await deadline(blocked.done)).status, 'failed'); assert.equal(f.model.requests.length, 0);
});
test('two scoped windows retain independent read grants; changed model destination blocks both', async t => {
  const f = await fixture(t);
  const one = await f.controller.request(f.request) as { sessionId: string };
  const two = await f.controller.request({ ...f.request, requestId: 'r2', context: { window: 'w2', resource: 'sheet2' },
    mcp: { ...f.request.mcp!, transport: { ...f.request.mcp!.transport, args: ['--scope', 'sheet2'] } } }) as { sessionId: string };
  assert.notEqual(one.sessionId, two.sessionId); assert.ok(f.mcp.check(one.sessionId)); assert.ok(f.mcp.check(two.sessionId));
  f.config.model = 'new-model'; assert.throws(() => f.mcp.check(one.sessionId)); assert.throws(() => f.mcp.check(two.sessionId));
});
test('handoff offer cannot inject environment secrets, HTTP endpoints or arbitrary fields', () => {
  const base = { protocol: launchProtocol, operation: 'open-session', requestId: 'r', application: { id: 'a', name: 'A', profile: 'p' }, context: { window: 'w', resource: 'r' } };
  for (const transport of [{ type: 'stdio', command: '/bin/tool', args: [], envRefs: { SECRET: 'file:key' } },
    { type: 'stdio', command: 'relative', args: [] }, { type: 'streamable-http', url: 'https://example.test' }]) {
    assert.throws(() => parseLaunchRequest({ ...base, mcp: { transport, scope: 'read', readTools: ['read'] } }));
  }
});
