import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, link, cp, realpath } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkspaceApi } from '../desktop/workspace/api';
import type { WorkspaceFile, WorkspaceProject, WorkspaceStatus } from '../shared/contracts';

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dreamedge-workspace-')));
  const profile = join(root, 'profile');
  const framework = join(root, 'framework');
  await mkdir(profile); await mkdir(framework);
  return { root, profile, framework, api: new WorkspaceApi(profile, framework),
    cleanup: () => rm(root, { recursive: true, force: true }) };
}
async function create(api: WorkspaceApi, root: string, name = 'HelloWorld') {
  return await api.execute({ operation: 'create', directory: join(root, name), name }) as WorkspaceProject;
}
test('workspace creates independent source and managed directories, saves metadata and restores after restart', async () => {
  const f = await fixture();
  try {
    const project = await create(f.api, f.root);
    const id = project.definition.id;
    assert.equal(project.sourceDirectory, join(project.rootDirectory, 'src'));
    for (const folder of [project.dataDirectory, project.buildDirectory, project.versionsDirectory, project.sessionsDirectory]) {
      assert.ok(folder.startsWith(join(f.profile, 'workspaces', id)));
      assert.ok(!folder.startsWith(project.rootDirectory));
    }
    assert.deepEqual(await f.api.execute({ operation: 'listFiles', projectId: id }), ['index.html', 'main.ts']);
    const original = await f.api.execute({ operation: 'readFile', projectId: id, path: 'main.ts' }) as WorkspaceFile;
    const updated = await f.api.execute({ operation: 'writeFile', projectId: id, path: 'main.ts', content: "document.body.textContent = 'Changed HelloWorld';\n", expectedHash: original.hash }) as WorkspaceFile;
    assert.notEqual(updated.hash, original.hash);
    await f.api.execute({ operation: 'writeFile', projectId: id, path: 'components/message.ts', content: 'export const message = "HelloWorld";', expectedHash: null });
    await f.api.execute({ operation: 'save', projectId: id, name: 'Renamed', version: '0.1.2' });
    const restarted = new WorkspaceApi(f.profile, f.framework);
    const status = await restarted.execute({ operation: 'current' }) as WorkspaceStatus;
    assert.equal(status.project?.definition.id, id);
    assert.equal(status.project?.definition.name, 'Renamed');
    assert.equal(status.project?.definition.version, '0.1.2');
    assert.equal((await restarted.execute({ operation: 'readFile', projectId: id, path: 'main.ts' }) as WorkspaceFile).content, updated.content);
    await restarted.execute({ operation: 'close' });
    assert.equal((await new WorkspaceApi(f.profile, f.framework).execute({ operation: 'current' }) as WorkspaceStatus).project, null);
    assert.equal((await restarted.execute({ operation: 'open', directory: project.rootDirectory }) as WorkspaceProject).definition.id, id);
  } finally { await f.cleanup(); }
});
test('file access rejects traversal, links, non-text and stale edits without changing existing data', async () => {
  const f = await fixture();
  try {
    const p = await create(f.api, f.root);
    const id = p.definition.id;
    const external = join(f.root, 'external.txt'); await writeFile(external, 'outside');
    for (const path of ['../external.txt', '/etc/passwd', 'C:\\secret', 'src/../../secret', '', 'file:stream']) {
      await assert.rejects(f.api.execute({ operation: 'readFile', projectId: id, path }));
      await assert.rejects(f.api.execute({ operation: 'writeFile', projectId: id, path, content: 'bad', expectedHash: null }));
    }
    await symlink(external, join(p.sourceDirectory, 'linked.txt'));
    await assert.rejects(f.api.execute({ operation: 'readFile', projectId: id, path: 'linked.txt' }), /链接/);
    await assert.rejects(f.api.execute({ operation: 'writeFile', projectId: id, path: 'linked.txt', content: 'bad', expectedHash: null }), /链接/);
    await symlink(f.framework, join(p.sourceDirectory, 'linked-folder'));
    await assert.rejects(f.api.execute({ operation: 'writeFile', projectId: id, path: 'linked-folder/new.ts', content: 'bad', expectedHash: null }), /链接/);
    await link(external, join(p.sourceDirectory, 'hardlinked.txt'));
    await assert.rejects(f.api.execute({ operation: 'readFile', projectId: id, path: 'hardlinked.txt' }), /硬链接/);
    const file = await f.api.execute({ operation: 'readFile', projectId: id, path: 'main.ts' }) as WorkspaceFile;
    await writeFile(join(p.sourceDirectory, 'main.ts'), 'external edit');
    await assert.rejects(f.api.execute({ operation: 'writeFile', projectId: id, path: 'main.ts', content: 'lost update', expectedHash: file.hash }), /发生变化/);
    await writeFile(join(p.sourceDirectory, 'binary'), Buffer.from([0xff, 0x00]));
    await assert.rejects(f.api.execute({ operation: 'readFile', projectId: id, path: 'binary' }));
    await assert.rejects(f.api.execute({ operation: 'writeFile', projectId: id, path: 'large.txt', content: 'x'.repeat(1048577), expectedHash: null }), /1 MB/);
    assert.equal(await readFile(external, 'utf8'), 'outside');
    assert.equal(await readFile(join(p.sourceDirectory, 'main.ts'), 'utf8'), 'external edit');
  } finally { await f.cleanup(); }
});
test('active project identity, protected directories and copied identities cannot be bypassed', async () => {
  const f = await fixture();
  try {
    const a = await create(f.api, f.root, 'First');
    const b = await create(f.api, f.root, 'Second');
    assert.notEqual(a.dataDirectory, b.dataDirectory);
    await assert.rejects(f.api.execute({ operation: 'readFile', projectId: a.definition.id, path: 'main.ts' }), /当前工程/);
    await f.api.execute({ operation: 'open', directory: a.rootDirectory });
    await assert.rejects(f.api.execute({ operation: 'readFile', projectId: b.definition.id, path: 'main.ts' }), /当前工程/);
    for (const path of [f.framework, join(f.framework, 'project'), f.profile, join(f.profile, 'project'), f.root]) {
      await assert.rejects(f.api.execute({ operation: 'create', directory: path, name: 'Forbidden' }));
    }
    const copy = join(f.root, 'Copy'); await cp(a.rootDirectory, copy, { recursive: true });
    await assert.rejects(f.api.execute({ operation: 'open', directory: copy }), /身份/);
    await assert.rejects(f.api.execute({ operation: 'create', directory: a.rootDirectory, name: 'Overwrite' }));
    const status = await f.api.execute({ operation: 'current' }) as WorkspaceStatus;
    status.project!.sourceDirectory = f.framework;
    assert.equal((await f.api.execute({ operation: 'current' }) as WorkspaceStatus).project?.sourceDirectory, a.sourceDirectory);
    assert.ok(!relative(a.rootDirectory, a.sourceDirectory).startsWith('..'));
  } finally { await f.cleanup(); }
});
test('invalid project metadata and failed restart recovery preserve source and permit explicit recovery', async () => {
  const f = await fixture();
  try {
    const p = await create(f.api, f.root);
    const metadata = join(p.rootDirectory, '.dreamedge/project.json');
    const valid = await readFile(metadata, 'utf8');
    await writeFile(metadata, JSON.stringify({ ...JSON.parse(valid), source: '../framework' }));
    await assert.rejects(f.api.execute({ operation: 'listFiles', projectId: p.definition.id }), /外部修改/);
    const restarted = new WorkspaceApi(f.profile, f.framework);
    const status = await restarted.execute({ operation: 'current' }) as WorkspaceStatus;
    assert.equal(status.project, null); assert.ok(status.recoveryError);
    await assert.rejects(restarted.execute({ operation: 'open', directory: p.rootDirectory }));
    assert.ok((await readFile(join(p.sourceDirectory, 'main.ts'), 'utf8')).includes('HelloWorld'));
    await writeFile(metadata, valid);
    await restarted.execute({ operation: 'open', directory: p.rootDirectory });
    assert.equal((await restarted.execute({ operation: 'current' }) as WorkspaceStatus).recoveryError, null);
    await assert.rejects(restarted.execute({ operation: 'save', projectId: p.definition.id, version: 'invalid' }));
    assert.equal(await readFile(metadata, 'utf8'), valid);
  } finally { await f.cleanup(); }
});
