import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { GitStatus } from '../shared/contracts';
import { ProjectGitApi } from '../desktop/git/api';
import { git } from '../desktop/git/command';
import { displayRemoteUrl } from '../desktop/git/remote';
import { fixture, proposal } from './development-fixture';

async function repository() {
  const f = await fixture(async () => proposal); const api = new ProjectGitApi(f.workspace, f.profile);
  const id = f.project.definition.id; const root = f.project.rootDirectory;
  const server = join(f.root, 'server.git'); await mkdir(server); await git(server, ['init', '--bare', '--initial-branch=main']);
  await git(root, ['remote', 'add', 'origin', server]);
  const status = () => api.execute({ operation: 'status', projectId: id }) as Promise<GitStatus>;
  const run = async (operation: 'commit' | 'discard' | 'fetch' | 'pull' | 'push') => api.execute({ operation, projectId: id, message: 'Local edit', expectedStateHash: (await status()).stateHash });
  const peer = join(f.root, 'peer');
  const clone = async () => { await git(f.root, ['clone', server, peer]); await git(peer, ['config', 'user.name', 'Peer']); await git(peer, ['config', 'user.email', 'peer@local']); };
  const edit = async (text: string) => { await writeFile(join(peer, 'src/main.ts'), `document.body.textContent=${JSON.stringify(text)};`); await git(peer, ['add', '--', 'src']); await git(peer, ['commit', '-m', text]); await git(peer, ['push', 'origin', 'main']); };
  return { ...f, api, id, repoRoot: root, server, peer, status, run, clone, edit, cleanupAll: async () => { await api.dispose(); await f.cleanup(); } };
}

test('remote Git publishes the first branch, fetches counts/history and fast-forwards the original repository', async () => {
  const f = await repository();
  try {
    const before = await f.status(); assert.equal(before.remote?.tracking, false); assert.equal(before.remote?.exists, false);
    await f.run('push'); await f.clone(); assert.equal((await f.status()).remote?.tracking, true);
    await f.edit('Remote greeting'); await f.run('fetch');
    const behind = await f.status(); assert.equal(behind.remote?.behind, 1); assert.equal(behind.remoteCommits[0].message, 'Remote greeting'); assert.ok(behind.fetchedAt);
    assert.equal(behind.commits[0].remoteState, 'pushed');
    await f.run('pull'); assert.match(await readFile(join(f.project.sourceDirectory, 'main.ts'), 'utf8'), /Remote greeting/);
    const pulled = await f.status(); assert.equal(pulled.remote?.behind, 0); assert.equal(pulled.changed.length, 0);
    await writeFile(join(f.project.sourceDirectory, 'main.ts'), "document.body.textContent='Local greeting';");
    await f.run('commit'); assert.equal((await f.status()).remote?.ahead, 1); assert.equal((await f.status()).commits[0].remoteState, 'local');
    await f.run('push'); assert.equal((await f.status()).remote?.ahead, 0); assert.equal((await f.status()).commits[0].remoteState, 'pushed');
    assert.equal((await git(f.server, ['rev-parse', 'refs/heads/main'])).trim(), (await f.status()).head);
  } finally { await f.cleanupAll(); }
});
test('discard restores the whole repository including staged root files while preserving ignored files, key and data', async () => {
  const f = await repository();
  try {
    await writeFile(join(f.root, 'project/.dreamedge/model.json'), 'secret'); await writeFile(join(f.project.dataDirectory, 'data'), 'keep-data');
    await writeFile(join(f.root, 'project/.gitignore'), (await readFile(join(f.root, 'project/.gitignore'), 'utf8')) + '/src/private.txt\n'); await f.run('commit');
    await writeFile(join(f.root, 'project/manual.txt'), 'manual'); await git(f.root + '/project', ['add', '--', 'manual.txt']);
    await writeFile(join(f.project.sourceDirectory, 'private.txt'), 'keep ignored');
    await writeFile(join(f.project.sourceDirectory, 'main.ts'), 'Uncommitted');
    await writeFile(join(f.project.sourceDirectory, 'new.ts'), 'New file'); await git(f.project.rootDirectory, ['add', '--', 'src']);
    const before = await f.status(); await f.run('discard'); const after = await f.status();
    assert.equal(after.head, before.head); assert.equal(after.changed.length, 0);
    await assert.rejects(readFile(join(f.project.rootDirectory, 'manual.txt')), { code: 'ENOENT' });
    assert.match(await readFile(join(f.project.sourceDirectory, 'main.ts'), 'utf8'), /HelloWorld/);
    await assert.rejects(readFile(join(f.project.sourceDirectory, 'new.ts')), { code: 'ENOENT' });
    assert.equal(await readFile(join(f.project.sourceDirectory, 'private.txt'), 'utf8'), 'keep ignored');
    assert.equal(await readFile(join(f.root, 'project/.dreamedge/model.json'), 'utf8'), 'secret');
    assert.equal(await readFile(join(f.project.dataDirectory, 'data'), 'utf8'), 'keep-data');
    assert.equal((await git(f.project.rootDirectory, ['diff', '--cached', '--name-only'])).trim(), '');
  } finally { await f.cleanupAll(); }
});
test('pull and push refuse divergence and dirty/stale state without changing source or HEAD', async () => {
  const f = await repository();
  try {
    await f.run('push'); await f.clone(); await f.edit('Remote divergent');
    await writeFile(join(f.project.sourceDirectory, 'main.ts'), 'Local divergent');
    await assert.rejects(f.run('pull'), /未提交/); await f.run('commit');
    const before = await f.status(); await assert.rejects(f.run('pull'), /分叉/); await assert.rejects(f.run('push'), /先拉取/);
    assert.equal((await f.status()).head, before.head); assert.equal(await readFile(join(f.project.sourceDirectory, 'main.ts'), 'utf8'), 'Local divergent');
    const stale = await f.status(); await writeFile(join(f.project.sourceDirectory, 'main.ts'), 'Further edit');
    await assert.rejects(f.api.execute({ operation: 'discard', projectId: f.id, expectedStateHash: stale.stateHash }), /状态已变化/);
    assert.equal(await readFile(join(f.project.sourceDirectory, 'main.ts'), 'utf8'), 'Further edit');
  } finally { await f.cleanupAll(); }
});
test('pull rejects remote model configuration before checkout', async () => {
  const f = await repository();
  try {
    await f.run('push'); await f.clone(); const before = await f.status();
    await writeFile(join(f.peer, '.dreamedge/model.json'), 'remote-key'); await git(f.peer, ['add', '-f', '--', '.dreamedge/model.json']);
    await git(f.peer, ['commit', '-m', 'Private file']); await git(f.peer, ['push']);
    await assert.rejects(f.run('pull'), /本机配置/); assert.equal((await f.status()).head, before.head);
  } finally { await f.cleanupAll(); }
});
test('remote display redacts secrets; Git mutations refuse active AI and remote failures retain local history', async () => {
  assert.equal(displayRemoteUrl('https://user:secret@example.com/repo?token=secret'), 'https://example.com/repo');
  const f = await repository();
  try {
    const before = await f.status();
    const guarded = new ProjectGitApi(f.workspace, f.profile, undefined, () => { throw new Error('AI 正在修改'); });
    await assert.rejects(guarded.execute({ operation: 'discard', projectId: f.id, expectedStateHash: before.stateHash }), /AI 正在修改/); await guarded.dispose();
    await git(f.project.rootDirectory, ['remote', 'set-url', 'origin', join(f.root, 'missing.git')]);
    await assert.rejects(f.run('fetch'), /远程 Git 操作失败/); assert.equal((await f.status()).head, before.head);
  } finally { await f.cleanupAll(); }
});

test('pull validates repository identity and refuses to overwrite ignored local files', async () => {
  const f = await repository();
  try {
    await writeFile(join(f.project.rootDirectory, '.gitignore'), (await readFile(join(f.project.rootDirectory, '.gitignore'), 'utf8')) + '/private.txt\n');
    await f.run('commit'); await f.run('push'); await f.clone(); const before = await f.status();
    await writeFile(join(f.project.rootDirectory, 'private.txt'), 'Local secret');
    await writeFile(join(f.peer, 'private.txt'), 'Remote file'); await git(f.peer, ['add', '-f', '--', 'private.txt']);
    await git(f.peer, ['commit', '-m', 'Remote ignored collision']); await git(f.peer, ['push']);
    await assert.rejects(f.run('pull'), /覆盖本机忽略文件/);
    assert.equal((await f.status()).head, before.head); assert.equal(await readFile(join(f.project.rootDirectory, 'private.txt'), 'utf8'), 'Local secret');
    const definition = JSON.parse(await readFile(join(f.peer, '.dreamedge/project.json'), 'utf8')); definition.id = 'd4bfa8fb-0713-4386-9e8f-6e78404853ae';
    await writeFile(join(f.peer, '.dreamedge/project.json'), JSON.stringify(definition));
    await git(f.peer, ['add', '--', '.dreamedge/project.json']); await git(f.peer, ['commit', '-m', 'Foreign identity']); await git(f.peer, ['push']);
    await assert.rejects(f.run('pull'), /不属于当前工程/); assert.equal((await f.status()).head, before.head);
  } finally { await f.cleanupAll(); }
});
