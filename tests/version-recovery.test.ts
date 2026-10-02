import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { VersionOperation, VersionStatus, WorkspaceStatus } from '../shared/contracts';
import { WorkspaceApi } from '../desktop/workspace/api';
import { VersionsApi } from '../desktop/versions/api';
import { versionFixture } from './version-fixture';

function crash(f: Awaited<ReturnType<typeof versionFixture>>, phase: string) {
  const result = spawnSync(process.execPath, ['--import', 'tsx', resolve('tests/version-crash-fixture.ts'), JSON.stringify({
    profile: f.profile, framework: f.framework, projectId: f.project.definition.id, buildId: f.build.id, phase,
  })], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 42, result.stderr);
}
test('process termination at each save phase restores one coherent source/metadata/history state', async () => {
  for (const phase of ['prepared', 'source-backed-up', 'source-installed', 'metadata-installed', 'history-installed', 'committed']) {
    const f = await versionFixture();
    try {
      const data = join(f.project.dataDirectory, 'record.json'); await writeFile(data, 'preserved');
      crash(f, phase);
      const workspace = new WorkspaceApi(f.profile, f.framework); const versions = new VersionsApi(workspace, f.profile);
      const status = await workspace.execute({ operation: 'current' }) as WorkspaceStatus;
      assert.equal(status.recoveryError, null, phase); assert.equal(status.project?.definition.id, f.project.definition.id);
      const content = await readFile(join(f.project.sourceDirectory, 'main.ts'), 'utf8');
      const history = await versions.execute({ operation: 'status', projectId: f.project.definition.id }) as VersionStatus;
      const operationId = (await readdir(join(f.project.versionsDirectory, 'operations')))[0].replace('.json', '');
      const operation = await versions.execute({ operation: 'getOperation', projectId: f.project.definition.id, operationId }) as VersionOperation;
      if (phase === 'committed') {
        assert.match(content, /Saved candidate/); assert.equal(status.project!.definition.version, '0.1.1');
        assert.equal(history.versions.length, 2); assert.equal(operation.status, 'completed');
      } else {
        assert.match(content, /HelloWorld/); assert.equal(status.project!.definition.version, '0.1.0');
        assert.deepEqual(history.versions, []); assert.equal(operation.status, 'interrupted');
      }
      assert.equal(await readFile(data, 'utf8'), 'preserved'); await versions.dispose();
    } finally { await f.cleanup(); }
  }
});
test('unknown external edits and forged recovery roots preserve transaction backups instead of overwriting source', async () => {
  const f = await versionFixture();
  try {
    crash(f, 'source-installed');
    await writeFile(join(f.project.sourceDirectory, 'main.ts'), 'user edit after crash');
    const workspace = new WorkspaceApi(f.profile, f.framework);
    const status = await workspace.execute({ operation: 'current' }) as WorkspaceStatus;
    assert.equal(status.project, null); assert.ok(status.recoveryError);
    assert.equal(await readFile(join(f.project.sourceDirectory, 'main.ts'), 'utf8'), 'user edit after crash');
    assert.match(await readFile(join(f.project.rootDirectory, '.dreamedge/transaction/previous/main.ts'), 'utf8'), /HelloWorld/);
  } finally { await f.cleanup(); }
  const forged = await versionFixture();
  try {
    crash(forged, 'prepared');
    const path = join(forged.project.rootDirectory, '.dreamedge/transaction/journal.json');
    const journal = JSON.parse(await readFile(path, 'utf8'));
    await writeFile(path, JSON.stringify({ ...journal, root: '/outside' }));
    const workspace = new WorkspaceApi(forged.profile, forged.framework);
    const status = await workspace.execute({ operation: 'current' }) as WorkspaceStatus;
    assert.equal(status.project, null); assert.ok(status.recoveryError);
    assert.match(await readFile(join(forged.project.sourceDirectory, 'main.ts'), 'utf8'), /HelloWorld/);
  } finally { await forged.cleanup(); }
});
