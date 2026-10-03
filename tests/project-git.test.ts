import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { GitStatus } from '../shared/contracts';
import { ProjectGitApi } from '../desktop/git/api';
import { git } from '../desktop/git/command';
import { applyState } from '../desktop/changes/apply';
import { currentVersionState } from '../desktop/changes/current';
import { fixture, proposal } from './development-fixture';

test('project Git history commits managed source and restores it without touching credentials, data or HEAD', async () => {
  const f = await fixture(async () => proposal); const api = new ProjectGitApi(f.workspace, f.profile);
  try {
    const before = await api.execute({ operation: 'status', projectId: f.project.definition.id }) as GitStatus;
    assert.equal(before.commits.length, 1);
    await writeFile(join(f.project.rootDirectory, '.dreamedge/model.json'), 'private-key-file'); await writeFile(join(f.project.dataDirectory, 'value'), 'Business data');
    await writeFile(join(f.project.rootDirectory, 'manual.txt'), 'Keep manually staged content');
    await git(f.project.rootDirectory, ['add', '--', 'manual.txt']);
    await writeFile(join(f.project.sourceDirectory, 'main.ts'), "document.body.textContent='Git update';");
    const changed = await api.execute({ operation: 'status', projectId: f.project.definition.id }) as GitStatus;
    await api.execute({ operation: 'commit', projectId: f.project.definition.id, message: 'Git update', expectedStateHash: changed.stateHash });
    const saved = await api.execute({ operation: 'status', projectId: f.project.definition.id }) as GitStatus;
    assert.equal(saved.commits.length, 2); assert.equal(saved.changed.length, 0);
    assert.equal((await git(f.project.rootDirectory, ['diff', '--cached', '--name-only', '--', 'manual.txt'])).trim(), 'manual.txt');
    assert.equal(await git(f.project.rootDirectory, ['ls-tree', 'HEAD', '--', 'manual.txt']), '');
    assert.equal(await git(f.project.rootDirectory, ['ls-files', '--', '.dreamedge/model.json']), '');
    await api.execute({ operation: 'restore', projectId: f.project.definition.id, commitId: before.head!, expectedStateHash: saved.stateHash });
    const restored = await api.execute({ operation: 'status', projectId: f.project.definition.id }) as GitStatus;
    assert.equal(restored.head, saved.head); assert.ok(restored.changed.length);
    assert.match(await readFile(join(f.project.sourceDirectory, 'main.ts'), 'utf8'), /HelloWorld/);
    assert.equal(await readFile(join(f.project.rootDirectory, '.dreamedge/model.json'), 'utf8'), 'private-key-file');
    assert.equal(await readFile(join(f.project.dataDirectory, 'value'), 'utf8'), 'Business data');
  } finally { await api.dispose(); await f.cleanup(); }
});
test('Git restore refuses dirty source, stale state and foreign project commits', async () => {
  const f = await fixture(async () => proposal); const api = new ProjectGitApi(f.workspace, f.profile);
  try {
    const before = await api.execute({ operation: 'status', projectId: f.project.definition.id }) as GitStatus;
    await writeFile(join(f.project.sourceDirectory, 'main.ts'), 'Manual edit');
    const status = await api.execute({ operation: 'status', projectId: f.project.definition.id }) as GitStatus;
    await assert.rejects(api.execute({ operation: 'restore', projectId: f.project.definition.id, commitId: before.head!, expectedStateHash: before.stateHash }), /状态已变化/);
    await assert.rejects(api.execute({ operation: 'restore', projectId: f.project.definition.id, commitId: before.head!, expectedStateHash: status.stateHash }), /未提交/);
  } finally { await api.dispose(); await f.cleanup(); }
});
test('a transactional source swap rolls back on failure and does not create framework version snapshots', async () => {
  const f = await fixture(async () => proposal);
  try {
    const current = await currentVersionState(f.project);
    await assert.rejects(applyState(f.project, f.profile, { ...current.files, 'main.ts': 'New source' }, current.definition,
      current.stateHash, new AbortController().signal, async phase => { if (phase === 'source-installed') throw new Error('Fixture failure'); }));
    assert.equal(await readFile(join(f.project.sourceDirectory, 'main.ts'), 'utf8'), current.files['main.ts']);
    await assert.rejects(readFile(join(f.project.rootDirectory, '.dreamedge/transaction/journal.json')), { code: 'ENOENT' });
  } finally { await f.cleanup(); }
});
test('a commit imported from another project cannot replace this project identity', async () => {
  const f = await fixture(async () => proposal); const api = new ProjectGitApi(f.workspace, f.profile);
  try {
    const original = await api.execute({ operation: 'status', projectId: f.project.definition.id }) as GitStatus;
    const other = await f.workspace.execute({ operation: 'create', directory: join(f.root, 'other'), name: 'Other' }) as import('../shared/contracts').WorkspaceProject;
    const foreign = (await git(other.rootDirectory, ['rev-parse', 'HEAD'])).trim();
    await git(f.project.rootDirectory, ['fetch', other.rootDirectory, 'HEAD']);
    await f.workspace.execute({ operation: 'open', directory: f.project.rootDirectory });
    await assert.rejects(api.execute({ operation: 'restore', projectId: f.project.definition.id, commitId: foreign, expectedStateHash: original.stateHash }), /不属于当前工程/);
  } finally { await api.dispose(); await f.cleanup(); }
});
