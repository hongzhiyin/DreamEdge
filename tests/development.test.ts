import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { DevelopmentSession, WorkspaceProject } from '../shared/contracts';
import { DevelopmentApi } from '../desktop/development/api';
import { WorkspaceApi } from '../desktop/workspace/api';
import { deferred, fixture, proposal } from './development-fixture';

test('model turns stage isolated candidates, persist history and leave project source unchanged', async () => {
  const inputs: unknown[] = [];
  const f = await fixture(async input => { inputs.push(structuredClone(input)); return proposal; });
  try {
    const metadataPath = join(f.project.rootDirectory, '.dreamedge/project.json');
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
    await writeFile(metadataPath, JSON.stringify({ ...metadata, privateNote: 'never-send-private-note' }));
    await f.workspace.execute({ operation: 'open', directory: f.project.rootDirectory });
    const source = await readFile(join(f.project.sourceDirectory, 'main.ts'), 'utf8');
    await f.send();
    const first = await f.settled(); const turn = first.turns[0];
    assert.equal(turn.status, 'completed'); assert.equal(turn.changes.length, 1);
    assert.equal(turn.changes[0].expectedHash, turn.context[0].hash);
    assert.equal(await readFile(join(f.project.sourceDirectory, 'main.ts'), 'utf8'), source);
    assert.equal(await readFile(join(f.project.sessionsDirectory, first.id, turn.id, 'candidate/src/main.ts'), 'utf8'), proposal.files[0].content);
    first.turns[0].changes[0].content = 'client tamper';
    assert.equal((await f.get()).turns[0].changes[0].content, proposal.files[0].content);
    await f.send('Explain the earlier suggestion'); await f.settled();
    assert.equal((inputs[1] as { history: unknown[] }).history.length, 1);
    const restored = new DevelopmentApi(new WorkspaceApi(f.profile, f.framework), f.provider);
    const session = await restored.execute({ operation: 'get', projectId: f.project.definition.id, sessionId: first.id }) as DevelopmentSession;
    assert.equal(session.turns.length, 2); assert.equal(session.turns[0].status, 'completed');
    assert.ok(!JSON.stringify(inputs[0]).includes(f.framework));
    assert.ok(!JSON.stringify(inputs[0]).includes('never-send-private-note'));
    assert.ok(!JSON.stringify((inputs[0] as { context: unknown }).context).includes(f.profile));
  } finally { await f.cleanup(); }
});
test('invalid context and malformed or escaping proposals cannot edit source or stage candidates', async () => {
  let result: unknown = proposal;
  const f = await fixture(async () => result);
  try {
    await assert.rejects(f.send('request', ['../outside']), /越界/);
    await assert.rejects(f.send('request', ['src/main.ts', 'src/main.ts']), /重复/);
    const cases = [null, { summary: 'bad', files: [{ path: '../outside', content: 'bad' }] },
      { summary: 'bad', files: [{ path: 'src/index.html', content: 'not in context' }] },
      { summary: 'bad', files: [proposal.files[0], proposal.files[0]] },
      { summary: 'bad', files: [{ path: 'src/main.ts/child.ts', content: 'bad' }] },
      { summary: 'bad', files: [{ path: 'src/new.ts', content: 'x'.repeat(131073) }] }];
    for (result of cases) {
      await f.send(); const session = await f.settled();
      assert.equal(session.turns.at(-1)!.status, 'failed'); assert.deepEqual(session.turns.at(-1)!.changes, []);
    }
    assert.ok((await readFile(join(f.project.sourceDirectory, 'main.ts'), 'utf8')).includes('HelloWorld'));
  } finally { await f.cleanup(); }
});
test('external source edits invalidate an in-flight proposal without overwriting the user edit', async () => {
  const answer = deferred<unknown>();
  const f = await fixture(() => answer.promise);
  try {
    await f.send();
    await writeFile(join(f.project.sourceDirectory, 'main.ts'), 'external edit');
    answer.resolve(proposal);
    assert.equal((await f.settled()).turns[0].status, 'failed');
    assert.equal(await readFile(join(f.project.sourceDirectory, 'main.ts'), 'utf8'), 'external edit');
  } finally { await f.cleanup(); }
});
test('cancel and timeout settle even when a provider ignores cancellation; concurrent sends are rejected', async () => {
  const f = await fixture(() => new Promise(() => {}));
  try {
    await f.send(); await assert.rejects(f.send(), /运行中/);
    const cancelled = await f.api.execute({ operation: 'cancel', projectId: f.project.definition.id, sessionId: f.session.id }) as DevelopmentSession;
    assert.equal(cancelled.turns[0].status, 'cancelled');
    const timeout = new DevelopmentApi(f.workspace, f.provider, 20);
    await timeout.execute({ operation: 'send', projectId: f.project.definition.id, sessionId: f.session.id, prompt: 'timeout', paths: ['src/main.ts'] });
    await new Promise(resolve => setTimeout(resolve, 50));
    const value = await timeout.execute({ operation: 'get', projectId: f.project.definition.id, sessionId: f.session.id }) as DevelopmentSession;
    assert.equal(value.turns.at(-1)!.status, 'failed'); assert.match(value.turns.at(-1)!.error!, /超时/);
    await timeout.dispose();
  } finally { await f.cleanup(); }
});
test('switching projects rejects old session requests and in-flight results stay in the original profile', async () => {
  const answer = deferred<unknown>(); const f = await fixture(() => answer.promise);
  try {
    await f.send();
    const turnId = (await f.get()).turns[0].id;
    const other = await f.workspace.execute({ operation: 'create', directory: join(f.root, 'second'), name: 'Second' }) as WorkspaceProject;
    await assert.rejects(f.get(), /当前工程/);
    await assert.rejects(f.api.execute({ operation: 'get', projectId: other.definition.id, sessionId: f.session.id }));
    answer.resolve(proposal);
    const record = join(f.project.sessionsDirectory, f.session.id, turnId, 'turn.json');
    const deadline = Date.now() + 2000;
    while (JSON.parse(await readFile(record, 'utf8')).status === 'running' && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const sessions = await f.api.execute({ operation: 'list', projectId: other.definition.id });
    assert.deepEqual(sessions, []);
    await f.workspace.execute({ operation: 'open', directory: f.project.rootDirectory });
    assert.equal((await f.get()).turns[0].status, 'failed');
    assert.ok((await readFile(join(other.sourceDirectory, 'main.ts'), 'utf8')).includes('HelloWorld'));
  } finally { await f.cleanup(); }
});
test('new files are staged with null base hashes and linked managed directories are rejected', async () => {
  const f = await fixture(async () => ({ summary: 'New file', files: [{ path: 'src/components/greeting.ts', content: 'export const greeting = "Hi";' }] }));
  try {
    await f.send(); const session = await f.settled();
    assert.equal(session.turns[0].status, 'completed'); assert.equal(session.turns[0].changes[0].expectedHash, null);
    await assert.rejects(readFile(join(f.project.sourceDirectory, 'components/greeting.ts')));
    const linked = 'a'.repeat(8) + '-aaaa-aaaa-aaaa-' + 'a'.repeat(12);
    await symlink(f.framework, join(f.project.sessionsDirectory, linked));
    await assert.rejects(f.api.execute({ operation: 'get', projectId: f.project.definition.id, sessionId: linked }), /链接/);
  } finally { await f.cleanup(); }
});
test('context limits and project metadata changes are checked before accepting model proposals', async () => {
  const answer = deferred<unknown>(); const f = await fixture(() => answer.promise);
  try {
    await writeFile(join(f.project.sourceDirectory, 'large.ts'), 'x'.repeat(131073));
    await assert.rejects(f.send('request', ['src/large.ts']), /128 KB/);
    await f.send();
    await f.workspace.execute({ operation: 'save', projectId: f.project.definition.id, version: '0.2.0' });
    answer.resolve(proposal);
    assert.equal((await f.settled()).turns[0].status, 'failed');
  } finally { await f.cleanup(); }
});
test('shutdown waits for cancelled requests to persist and refuses new work', async () => {
  const f = await fixture(() => new Promise(() => {}));
  try {
    await f.send(); await f.api.dispose();
    await assert.rejects(f.send(), /关闭/);
    const restored = new DevelopmentApi(f.workspace, f.provider);
    const session = await restored.execute({ operation: 'get', projectId: f.project.definition.id, sessionId: f.session.id }) as DevelopmentSession;
    assert.equal(session.turns[0].status, 'failed'); assert.match(session.turns[0].error!, /关闭/);
  } finally { await f.cleanup(); }
});
test('restart marks abandoned running turns interrupted and strips raw provider errors', async () => {
  const f = await fixture(async () => { throw new Error('secret-api-key provider payload'); });
  try {
    await f.send(); const failed = await f.settled();
    assert.ok(!JSON.stringify(failed).includes('secret-api-key'));
    const turn = failed.turns[0]; const path = join(f.project.sessionsDirectory, f.session.id, turn.id, 'turn.json');
    await writeFile(path, JSON.stringify({ ...turn, status: 'running', error: null, finishedAt: null }));
    const recovered = await f.get();
    assert.equal(recovered.turns[0].status, 'interrupted');
    await assert.rejects(f.api.execute({ operation: 'get', projectId: f.project.definition.id, sessionId: '../outside' }), /身份/);
  } finally { await f.cleanup(); }
});
