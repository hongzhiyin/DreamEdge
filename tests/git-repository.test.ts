import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { GitStatus } from '../shared/contracts';
import { ProjectGitApi } from '../desktop/git/api';
import { git } from '../desktop/git/command';
import { fixture, proposal } from './development-fixture';

async function setup() {
  const f = await fixture(async () => proposal); const api = new ProjectGitApi(f.workspace, f.profile); const projectId = f.project.definition.id;
  const status = () => api.execute({ operation: 'status', projectId }) as Promise<GitStatus>;
  const run = async (operation: 'commit' | 'discard', expectedStateHash?: string) => api.execute({ operation, projectId,
    message: 'Whole repository', expectedStateHash: expectedStateHash ?? (await status()).stateHash });
  return { ...f, api, projectId, status, run, close: async () => { await api.dispose(); await f.cleanup(); } };
}
test('all root, nested, binary and staged files are listed/committed; ignored files stay outside the repository', async () => {
  const f = await setup(); const root = f.project.rootDirectory;
  try {
    await mkdir(join(root, 'assets'));
    await writeFile(join(root, 'README.md'), 'Project readme'); await writeFile(join(root, 'assets/icon.bin'), Buffer.from([0, 1, 2, 255]));
    await writeFile(join(root, 'staged.txt'), 'Staged root'); await git(root, ['add', '--', 'staged.txt']);
    await writeFile(join(root, '.DS_Store'), 'Finder'); await writeFile(join(root, '.dreamedge/model.json'), 'secret');
    const status = await f.status(); assert.ok(status.changed.includes('README.md')); assert.ok(status.changed.includes('assets/icon.bin')); assert.ok(status.changed.includes('staged.txt'));
    assert.ok(!status.changed.includes('.DS_Store')); assert.ok(!status.changed.includes('.dreamedge/model.json')); assert.ok(!('otherChanged' in status));
    await f.run('commit'); assert.equal((await f.status()).changed.length, 0);
    assert.match(await git(root, ['ls-tree', '-r', '--name-only', 'HEAD']), /README.md[\s\S]*assets\/icon.bin[\s\S]*staged.txt/);
    assert.equal(await git(root, ['ls-files', '--', '.DS_Store', '.dreamedge/model.json']), '');
    await writeFile(join(root, 'README.md'), 'Changed outside src'); await rm(join(root, 'assets/icon.bin'));
    await writeFile(join(root, 'new.txt'), 'New root file'); await writeFile(join(root, 'staged.txt'), 'Changed stage'); await git(root, ['add', '--', 'staged.txt']);
    const head = (await f.status()).head; await f.run('discard'); assert.equal((await f.status()).head, head); assert.equal((await f.status()).changed.length, 0);
    assert.equal(await readFile(join(root, 'README.md'), 'utf8'), 'Project readme'); assert.equal(await readFile(join(root, 'staged.txt'), 'utf8'), 'Staged root');
    assert.deepEqual(await readFile(join(root, 'assets/icon.bin')), Buffer.from([0, 1, 2, 255]));
    await assert.rejects(readFile(join(root, 'new.txt')), { code: 'ENOENT' }); assert.equal(await readFile(join(root, '.DS_Store'), 'utf8'), 'Finder');
  } finally { await f.close(); }
});
test('root file contents participate in stale-state checks, including untracked and binary files', async () => {
  const f = await setup();
  try {
    const path = join(f.project.rootDirectory, 'asset.bin'); await writeFile(path, Buffer.from([0, 1])); const before = await f.status();
    await writeFile(path, Buffer.from([0, 2]));
    assert.notEqual((await f.status()).stateHash, before.stateHash);
    await assert.rejects(f.run('discard', before.stateHash), /状态已变化/); await assert.rejects(f.run('commit', before.stateHash), /状态已变化/);
    assert.deepEqual(await readFile(path), Buffer.from([0, 2]));
  } finally { await f.close(); }
});
test('new ignore rules do not untrack an existing root file and historical restore covers root content', async () => {
  const f = await setup(); const root = f.project.rootDirectory;
  try {
    await writeFile(join(root, 'README.md'), 'Version one'); await f.run('commit'); const baseline = await f.status();
    await writeFile(join(root, '.gitignore'), (await readFile(join(root, '.gitignore'), 'utf8')) + '/README.md\n');
    await writeFile(join(root, 'README.md'), 'Version two'); await f.run('commit'); const before = await f.status();
    await writeFile(join(root, 'README.md'), 'Still tracked'); assert.ok((await f.status()).changed.includes('README.md')); await f.run('discard');
    assert.equal(await readFile(join(root, 'README.md'), 'utf8'), 'Version two');
    await f.api.execute({ operation: 'restore', projectId: f.projectId, commitId: baseline.head!, expectedStateHash: (await f.status()).stateHash });
    assert.equal(await readFile(join(root, 'README.md'), 'utf8'), 'Version one'); assert.equal((await f.status()).head, before.head);
  } finally { await f.close(); }
});
test('discard preserves files ignored by a newly edited .gitignore and refuses ignored-file collisions', async () => {
  const f = await setup(); const root = f.project.rootDirectory;
  try {
    await writeFile(join(root, '.gitignore'), (await readFile(join(root, '.gitignore'), 'utf8')) + '/local-only/\n');
    await mkdir(join(root, 'local-only')); await writeFile(join(root, 'local-only/value'), 'Keep local');
    await f.run('discard'); assert.equal(await readFile(join(root, 'local-only/value'), 'utf8'), 'Keep local');
    await rm(join(root, 'local-only'), { recursive: true });
    await writeFile(join(root, 'collision'), 'Tracked file'); await f.run('commit');
    await rm(join(root, 'collision')); await mkdir(join(root, 'collision')); await writeFile(join(root, 'collision/local'), 'Keep ignored');
    await writeFile(join(root, '.gitignore'), (await readFile(join(root, '.gitignore'), 'utf8')) + '/collision/local\n');
    const before = await f.status(); await assert.rejects(f.run('discard'), /覆盖本机忽略文件/);
    assert.equal(await readFile(join(root, 'collision/local'), 'utf8'), 'Keep ignored'); assert.equal((await f.status()).head, before.head);
  } finally { await f.close(); }
});

test('status fingerprints symlinks without reading through replaced directory parents', async () => {
  const { symlink } = await import('node:fs/promises');
  const { changedFilesFingerprint } = await import('../desktop/git/fingerprint');
  const f = await setup(); const root = f.project.rootDirectory;
  try {
    const outside = join(f.root, 'outside'); await mkdir(outside); await writeFile(join(outside, 'value'), 'External value');
    await symlink(outside, join(root, 'linked'));
    const before = await changedFilesFingerprint(root, ['linked', 'linked/value']);
    await writeFile(join(outside, 'value'), 'Changed external value');
    assert.equal(await changedFilesFingerprint(root, ['linked', 'linked/value']), before);
  } finally { await f.close(); }
});
