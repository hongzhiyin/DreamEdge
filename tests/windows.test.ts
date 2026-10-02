import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DevelopmentSession, WorkspaceProject } from '../shared/contracts';
import { WindowState } from '../desktop/windows/state';
import { windowFixture } from './window-fixture';
import { deferred } from './development-fixture';

test('two window workspaces share an identity catalog without overwriting selection or project data', async () => {
  const f = await windowFixture();
  try {
    const ta = f.a.tools()[0]; const tb = f.b.tools()[0];
    assert.notEqual(ta.id, tb.id); assert.notEqual(ta.contextId, tb.contextId); assert.notEqual(ta.appId, tb.appId);
    await Promise.all([f.a.storage(ta.id, { operation: 'put', collection: 'records', id: 'same', value: 'A' }, ta.contextId),
      f.b.storage(tb.id, { operation: 'put', collection: 'records', id: 'same', value: 'B' }, tb.contextId)]);
    assert.deepEqual(await f.a.storage(ta.id, { operation: 'list', collection: 'records' }, ta.contextId), [{ id: 'same', value: 'A' }]);
    assert.deepEqual(await f.b.storage(tb.id, { operation: 'list', collection: 'records' }, tb.contextId), [{ id: 'same', value: 'B' }]);
    await assert.rejects(f.a.storage(tb.id, { operation: 'list', collection: 'records' }, tb.contextId), /不属于/);
    await assert.rejects(f.a.workspace!.execute({ operation: 'readFile', projectId: f.pb.definition.id, path: 'main.ts' }), /当前工程/);
    const registry = JSON.parse(await readFile(join(f.profile, 'workspace-state.json'), 'utf8'));
    assert.equal(registry.projects.length, 2);
    const records = await new WindowState(f.profile).records();
    const a = await f.a.info(); const b = await f.b.info();
    assert.equal(records.find(record => record.id === a.id)?.project?.id, f.pa.definition.id);
    assert.equal(records.find(record => record.id === b.id)?.project?.id, f.pb.definition.id);
  } finally { await f.cleanup(); }
});
test('project switching revokes old content tokens and duplicate open projects cannot bind to another window', async () => {
  const f = await windowFixture();
  try {
    const old = f.a.tools()[0];
    await assert.rejects(f.a.executeWorkspace({ operation: 'open', directory: f.pb.rootDirectory }), /另一个开发窗口/);
    assert.equal((await f.a.info()).project?.id, f.pa.definition.id);
    const next = await f.a.executeWorkspace({ operation: 'create', directory: join(f.root, 'C'), name: 'C' }) as WorkspaceProject;
    const current = f.a.tools()[0];
    await assert.rejects(f.a.storage(old.id, { operation: 'put', collection: 'records', id: 'stale', value: 'bad' }, old.contextId), /过期/);
    assert.deepEqual(await f.a.storage(current.id, { operation: 'list', collection: 'records' }, current.contextId), []);
    assert.equal((await f.b.info()).project?.id, f.pb.definition.id); assert.notEqual(next.definition.id, f.pa.definition.id);
  } finally { await f.cleanup(); }
});
test('closing one window cancels only its own model request, while the other window continues', async () => {
  const pending = deferred<unknown>();
  const provider = { connection: async () => ({ provider: 'fixture', available: true, detail: 'Test' }), generate: () => pending.promise };
  const f = await windowFixture(provider);
  try {
    const sa = await f.a.development!.execute({ operation: 'create', projectId: f.pa.definition.id, title: 'A session' }) as DevelopmentSession;
    const sb = await f.b.development!.execute({ operation: 'create', projectId: f.pb.definition.id, title: 'B session' }) as DevelopmentSession;
    await Promise.all([f.a.development!.execute({ operation: 'send', projectId: f.pa.definition.id, sessionId: sa.id, prompt: 'A', paths: ['main.ts'] }),
      f.b.development!.execute({ operation: 'send', projectId: f.pb.definition.id, sessionId: sb.id, prompt: 'B', paths: ['main.ts'] })]);
    await f.a.dispose();
    const active = await f.b.development!.execute({ operation: 'get', projectId: f.pb.definition.id, sessionId: sb.id }) as DevelopmentSession;
    assert.equal(active.turns[0].status, 'running');
    pending.resolve({ summary: 'B completed', files: [] });
    let result = active;
    while (result.turns[0].status === 'running') {
      await new Promise(resolve => setTimeout(resolve, 10));
      result = await f.b.development!.execute({ operation: 'get', projectId: f.pb.definition.id, sessionId: sb.id }) as DevelopmentSession;
    }
    assert.equal(result.turns[0].status, 'completed');
    await assert.rejects(f.b.development!.execute({ operation: 'get', projectId: f.pb.definition.id, sessionId: sa.id }));
  } finally { pending.resolve({ summary: 'Done', files: [] }); await f.cleanup(); }
});
test('window records preserve bounds and selections independently, and reject malformed or duplicate restoration data', async () => {
  const f = await windowFixture();
  try {
    const a = await f.a.info(); const b = await f.b.info();
    const bounds = { x: 12, y: 18, width: 1000, height: 700 };
    await Promise.all([f.windows.bounds(a.id, bounds), f.windows.close(b.id)]);
    const records = await new WindowState(f.profile).records();
    assert.deepEqual(records.find(record => record.id === a.id)!.bounds, bounds);
    assert.equal(records.find(record => record.id === b.id)!.open, false);
    const path = join(f.profile, 'windows-state.json');
    const state = JSON.parse(await readFile(path, 'utf8')); state.windows.push(state.windows[0]);
    await writeFile(path, JSON.stringify(state));
    const broken = new WindowState(f.profile); await assert.rejects(broken.ready, /窗口恢复记录/);
  } finally { await f.cleanup(); }
});
