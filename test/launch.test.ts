import { execFileSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LaunchController } from '../src/launch/controller.js';
import { LaunchStore } from '../src/launch/store.js';
import { launchProtocol, parseLaunchRequest, type OpenSession } from '../src/launch/protocol.js';
import { callControl, startControl } from '../src/launch/socket.js';
import { WebHandoffs } from '../web/handoff.js';
import { conversationFixture, assistant } from './helpers/conversation.js';

const request: OpenSession = { protocol: launchProtocol, operation: 'open-session', requestId: 'one',
  application: { id: 'example.editor', name: 'Editor', profile: 'default' }, context: { window: 'window-1', resource: 'document-1' } };
test('launch serializes clicks, persists trust/binding, isolates resources and revokes without removing history', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'launch-')), f = conversationFixture(); let prompts = 0;
  let store = new LaunchStore(join(dir, 'launch.sqlite'));
  const revoked: string[] = [];
  const page = async () => ({ issueHandoff: (sessionId: string) => ({ url: 'http://localhost/' + sessionId, expiresAt: 1 }),
    revokeSession: (sessionId: string) => { revoked.push(sessionId); } });
  const controller = () => new LaunchController(store, f.service, f.config, page, async () => { prompts++; return true; });
  try {
    let c = controller();
    const results = await Promise.all([c.request(request), c.request(request)]) as { sessionId: string; resumed: boolean }[];
    assert.equal(results[0]!.sessionId, results[1]!.sessionId); assert.equal(prompts, 1);
    assert.equal(f.service.listSessions().length, 1); assert.equal(results[1]!.resumed, true);
    assert.equal(f.service.getSnapshot(results[0]!.sessionId).session.toolsDisabled, true);
    assert.equal(f.calls.length, 0);
    await assert.rejects(c.request({ ...request, context: { ...request.context, resource: 'other' } }), /标识/);
    await c.request({ ...request, requestId: 'two', context: { ...request.context, resource: 'other' } });
    assert.equal(f.service.listSessions().length, 2);
    store.close(); store = new LaunchStore(join(dir, 'launch.sqlite')); c = controller();
    await c.request(request); assert.equal(prompts, 1);
    await c.request({ protocol: launchProtocol, operation: 'revoke', application: request.application });
    assert.equal(revoked.length, 2); assert.equal(f.service.listSessions().length, 2);
    await c.request(request); assert.equal(prompts, 2);
  } finally { store.close(); await f.service.dispose(); await rm(dir, { recursive: true, force: true }); }
});
test('denied trust creates no conversation; model destination changes require renewed trust', async () => {
  const f = conversationFixture(), store = new LaunchStore(':memory:'); let allow = false, prompts = 0;
  const c = new LaunchController(store, f.service, f.config, async () => ({ issueHandoff: () => ({ url: '', expiresAt: 1 }), revokeSession: () => {} }),
    async () => { prompts++; return allow; });
  try {
    await assert.rejects(c.request(request), /未允许/); assert.equal(f.service.listSessions().length, 0);
    allow = true; await c.request(request); f.config.model = 'different'; await c.request(request); assert.equal(prompts, 3);
  } finally { store.close(); await f.service.dispose(); }
});
test('launch schema rejects extra authority claims and unknown protocols', () => {
  assert.throws(() => parseLaunchRequest({ ...request, approved: true }));
  assert.throws(() => parseLaunchRequest({ ...request, protocol: 'future/v8' }));
  assert.throws(() => parseLaunchRequest({ ...request, context: { ...request.context, tools: ['shell'] } }));
});
test('local socket uses owner-only permissions and structured errors', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'launch-sock-'));
  const server = await startControl(dir, async value => parseLaunchRequest(value));
  try {
    if (process.platform !== 'win32') assert.equal((await stat(join(dir, 'control.sock'))).mode & 0o777, 0o600);
    else assert.ok((await stat(join(dir, 'control-pipe'))).isFile());
    assert.deepEqual(await callControl(dir, request), { ok: true, data: request });
    assert.equal((await callControl(dir, {}) as { ok: boolean }).ok, false);
  } finally { await server.close(); await rm(dir, { recursive: true, force: true }); }
});
test('handoff expires, is single-use, and revocation only removes its conversation credentials', () => {
  let now = 0; const auth = new WebHandoffs(() => now);
  const stale = auth.issue('a'); now = stale.expiresAt; assert.equal(auth.exchange(stale.ticket), undefined);
  const a = auth.issue('a'), b = auth.issue('b');
  const pairedA = auth.exchange(a.ticket)!, pairedB = auth.exchange(b.ticket)!;
  assert.equal(auth.exchange(a.ticket), undefined); auth.revoke('a');
  assert.equal(auth.get(pairedA.token), undefined); assert.ok(auth.get(pairedB.token));
});

test('text-only session policy survives persistence and skips dynamic tool preparation', async () => {
  const { ConversationService, SqliteSessionStore } = await import('../src/index.js');
  const { builtInTools } = await import('../src/tools/builtins.js');
  const f = conversationFixture(); let prepared = false;
  const dir = await mkdtemp(join(tmpdir(), 'launch-policy-'));
  const path = join(dir, 'sessions.sqlite');
  const setup = () => new ConversationService({ store: new SqliteSessionStore(path), connection: () => f.config,
    tools: () => builtInTools().snapshots(), prepareTools: async () => { prepared = true; throw new Error('should not prepare'); },
    runtime: () => ({ start: request => {
      assert.equal(request.tools, undefined);
      return { cancel() {}, done: Promise.resolve({ sessionId: request.sessionId, runId: request.runId, status: 'completed' as const, text: 'ok', stopReason: 'stop', message: assistant('ok') }) };
    } }) });
  let service = setup();
  try {
    const id = service.createSession({ connectionId: f.config.id, toolsDisabled: true }).sessionId;
    await service.dispose(); service = setup(); assert.equal(service.getSnapshot(id).session.toolsDisabled, true);
    const run = service.send({ sessionId: id, clientMessageId: 'test', text: 'hello' }); await run.done;
    assert.equal(prepared, false); assert.equal(service.getSnapshot(id).runs[0]!.status, 'completed');
  } finally { await service.dispose(); await f.service.dispose(); await rm(dir, { recursive: true, force: true }); }
});

test('Windows client rejects a discovery directory shared with other accounts', { skip: process.platform !== 'win32' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'launch-acl-'));
  const server = await startControl(dir, async value => value);
  try {
    execFileSync('icacls.exe', [dir, '/grant', '*S-1-1-0:(OI)(CI)R'], { stdio: 'pipe' });
    await assert.rejects(callControl(dir, request), { code: 'UNSAFE_SOCKET' });
  } finally { await server.close(); await rm(dir, { recursive: true, force: true }); }
});
