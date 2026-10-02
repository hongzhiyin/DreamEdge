import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { VersionOperation, VersionStatus, WorkspaceProject } from '../shared/contracts';
import { WorkspaceApi } from '../desktop/workspace/api';
import { VersionsApi } from '../desktop/versions/api';
import { deferred } from './development-fixture';
import { versionFixture } from './version-fixture';

test('confirmed candidates save complete source and metadata versions; restore preserves data and removes candidate-only files', async () => {
  const f = await versionFixture();
  try {
    const original = await readFile(join(f.project.sourceDirectory, 'main.ts'), 'utf8');
    const data = join(f.project.dataDirectory, 'record.json'); await writeFile(data, '{"business":"preserved"}');
    const saved = await f.settledVersion(await f.confirm());
    assert.equal(saved.status, 'completed'); assert.ok(saved.versionId); assert.ok(saved.checkpointId);
    assert.match(await readFile(join(f.project.sourceDirectory, 'main.ts'), 'utf8'), /Saved candidate/);
    const status = await f.versions.execute({ operation: 'status', projectId: f.project.definition.id }) as VersionStatus;
    assert.equal(status.versions.length, 2); assert.equal(status.head, saved.versionId);
    assert.equal(status.versions[1].definition.version, '0.1.1');
    const restored = await f.versions.execute({ operation: 'restore', projectId: f.project.definition.id,
      versionId: saved.checkpointId!, expectedStateHash: status.stateHash, label: 'Restore original' }) as VersionOperation;
    assert.equal((await f.settledVersion(restored)).status, 'completed');
    assert.equal(await readFile(join(f.project.sourceDirectory, 'main.ts'), 'utf8'), original);
    await assert.rejects(readFile(join(f.project.sourceDirectory, 'components/greeting.ts')));
    assert.equal(await readFile(data, 'utf8'), '{"business":"preserved"}');
    const workspace = new WorkspaceApi(f.profile, f.framework); const versions = new VersionsApi(workspace, f.profile);
    const recovered = await versions.execute({ operation: 'status', projectId: f.project.definition.id }) as VersionStatus;
    assert.equal(recovered.versions.length, 4); assert.equal(recovered.versions.at(-1)!.kind, 'restored');
    assert.equal(recovered.versions.at(-1)!.definition.version, '0.1.0'); await versions.dispose();
  } finally { await f.cleanup(); }
});
test('stale source, tampered candidate copies and corrupted saved snapshots never overwrite current source', async () => {
  const f = await versionFixture();
  try {
    const path = join(f.project.sourceDirectory, 'main.ts'); const original = await readFile(path, 'utf8');
    await writeFile(path, 'external edit'); await assert.rejects(f.confirm(), /过期/); assert.equal(await readFile(path, 'utf8'), 'external edit');
    await writeFile(path, original);
    const candidate = join(f.project.buildDirectory, f.build.id, 'source/main.ts'); const expected = await readFile(candidate, 'utf8');
    await writeFile(candidate, 'tamper'); await assert.rejects(f.confirm(), /候选源码/); await writeFile(candidate, expected);
    const saved = await f.settledVersion(await f.confirm());
    const status = await f.versions.execute({ operation: 'status', projectId: f.project.definition.id }) as VersionStatus;
    await writeFile(join(f.project.versionsDirectory, saved.checkpointId!, 'source/main.ts'), 'tampered snapshot');
    await assert.rejects(f.versions.execute({ operation: 'restore', projectId: f.project.definition.id,
      versionId: saved.checkpointId!, expectedStateHash: status.stateHash, label: 'Rejected' }), /版本源码/);
    assert.match(await readFile(path, 'utf8'), /Saved candidate/);
    await writeFile(path, 'newer user edit');
    await assert.rejects(f.versions.execute({ operation: 'restore', projectId: f.project.definition.id,
      versionId: saved.versionId!, expectedStateHash: status.stateHash, label: 'Rejected' }), /状态已变化/);
    assert.equal(await readFile(path, 'utf8'), 'newer user edit');
  } finally { await f.cleanup(); }
});
test('external edits during preparation and cancellation before the swap leave source unchanged', async () => {
  const entered = deferred<void>(); const resume = deferred<void>();
  const f = await versionFixture(async phase => { if (phase === 'prepared') { entered.resolve(); await resume.promise; } });
  try {
    const operation = await f.confirm(); await entered.promise;
    await writeFile(join(f.project.sourceDirectory, 'main.ts'), 'user edit during preparation'); resume.resolve();
    assert.equal((await f.settledVersion(operation)).status, 'failed');
    assert.equal(await readFile(join(f.project.sourceDirectory, 'main.ts'), 'utf8'), 'user edit during preparation');
    const status = await f.versions.execute({ operation: 'status', projectId: f.project.definition.id }) as VersionStatus;
    assert.deepEqual(status.versions, []);
  } finally { resume.resolve(); await f.cleanup(); }
  const held = deferred<void>(); const release = deferred<void>();
  const cancelled = await versionFixture(async phase => { if (phase === 'prepared') { held.resolve(); await release.promise; } });
  try {
    const operation = await cancelled.confirm(); await held.promise;
    const result = cancelled.versions.execute({ operation: 'cancel', projectId: cancelled.project.definition.id, operationId: operation.id });
    release.resolve(); assert.equal((await result as VersionOperation).status, 'cancelled');
    assert.match(await readFile(join(cancelled.project.sourceDirectory, 'main.ts'), 'utf8'), /HelloWorld/);
  } finally { release.resolve(); await cancelled.cleanup(); }
});
test('cancellation after the swap point completes consistently instead of reporting a false cancellation', async () => {
  const entered = deferred<void>(); const resume = deferred<void>();
  const f = await versionFixture(async phase => { if (phase === 'source-backed-up') { entered.resolve(); await resume.promise; } });
  try {
    const operation = await f.confirm(); await entered.promise;
    const result = f.versions.execute({ operation: 'cancel', projectId: f.project.definition.id, operationId: operation.id });
    resume.resolve(); assert.equal((await result as VersionOperation).status, 'completed');
    assert.match(await readFile(join(f.project.sourceDirectory, 'main.ts'), 'utf8'), /Saved candidate/);
  } finally { resume.resolve(); await f.cleanup(); }
});
test('preparation timeout does not commit, and errors after source swap roll back source and history', async () => {
  const timeout = await versionFixture(async phase => { if (phase === 'prepared') await new Promise(resolve => setTimeout(resolve, 50)); }, 10);
  try {
    const result = await timeout.settledVersion(await timeout.confirm());
    assert.equal(result.status, 'failed'); assert.match(result.error!, /超时/);
    assert.match(await readFile(join(timeout.project.sourceDirectory, 'main.ts'), 'utf8'), /HelloWorld/);
  } finally { await timeout.cleanup(); }
  for (const stage of ['source-backed-up', 'source-installed', 'metadata-installed', 'history-installed']) {
    const f = await versionFixture(async phase => { if (phase === stage) throw new Error('Injected failure'); });
    try {
      assert.equal((await f.settledVersion(await f.confirm())).status, 'failed');
      assert.match(await readFile(join(f.project.sourceDirectory, 'main.ts'), 'utf8'), /HelloWorld/);
      const status = await f.versions.execute({ operation: 'status', projectId: f.project.definition.id }) as VersionStatus;
      assert.deepEqual(status.versions, []); assert.equal(status.head, null);
    } finally { await f.cleanup(); }
  }
});
test('versions and operations remain bound to their project when switching workspaces', async () => {
  const f = await versionFixture();
  try {
    const saved = await f.settledVersion(await f.confirm());
    const other = await f.workspace.execute({ operation: 'create', directory: join(f.root, 'second'), name: 'Second' }) as WorkspaceProject;
    await assert.rejects(f.versions.execute({ operation: 'status', projectId: f.project.definition.id }), /当前工程/);
    const status = await f.versions.execute({ operation: 'status', projectId: other.definition.id }) as VersionStatus;
    await assert.rejects(f.versions.execute({ operation: 'restore', projectId: other.definition.id,
      versionId: saved.versionId!, expectedStateHash: status.stateHash, label: 'Foreign version' }), /不属于/);
    await assert.rejects(f.versions.execute({ operation: 'getOperation', projectId: other.definition.id, operationId: saved.id }));
    assert.match(await readFile(join(other.sourceDirectory, 'main.ts'), 'utf8'), /HelloWorld/);
  } finally { await f.cleanup(); }
});
