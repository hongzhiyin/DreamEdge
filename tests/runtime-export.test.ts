import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { exportFixture } from './export-fixture';
import { copyResource } from '../desktop/export/resources';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { validateManifest } from '../desktop/project';
import { WorkspaceApi } from '../desktop/workspace/api';
import type { AppManifest, ProjectExport, WorkspaceProject } from '../shared/contracts';

test('staged production App contains compiled content and a lean runtime, without source, clones, framework bundles or development tools', async () => {
  let manifest: AppManifest;
  const f = await exportFixture(async input => { manifest = input.manifest; await copyResource(join(input.root, 'application'), join(f.root, 'staged')); });
  try {
    const record = await f.exports.execute({ operation: 'start', projectId: f.project.definition.id, directory: join(f.root, 'output') }) as ProjectExport;
    assert.equal((await f.settled(record.id)).status, 'succeeded');
    assert.deepEqual(manifest!.capabilities, ['storage']); assert.ok(!('development' in manifest!));
    const root = join(f.root, 'staged');
    for (const path of ['dist/runtime/business-runtime.cjs', 'dist/runtime/preload.cjs', `dist/tools/${manifest!.id}/index.html`]) await access(join(root, path));
    for (const path of ['src', 'dist/development', 'dist/framework', 'dist/runtime/runtime.cjs', 'dist/runtime/build-worker.cjs', 'dist/runtime/export-worker.cjs', 'node_modules']) await assert.rejects(access(join(root, path)));
    const metadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')); assert.equal(metadata.dependencies, undefined);
    assert.equal((await f.workspace.execute({ operation: 'current' }) as any).project.rootDirectory, f.project.rootDirectory);
    await assert.rejects(f.exports.execute({ operation: 'start', projectId: f.project.definition.id, mode: 'development', directory: join(f.root, 'bad') }), /原工程/);
    await assert.rejects(access(join(f.root, 'bad')));
    assert.throws(() => validateManifest({ ...manifest!, development: {} }), /原工程不会被删除/);
  } finally { await f.cleanup(); }
});
test('an existing legacy App project can be opened in DreamEdge without cloning, replacing local edits, changing identity or losing Key/Git', async () => {
  const f = await exportFixture();
  try {
    const legacy = join(f.root, 'legacy-app-profile/project'); await mkdir(join(f.root, 'legacy-app-profile'));
    const oldTools = join(f.root, 'old-app-tools'); await mkdir(oldTools);
    const oldApi = new WorkspaceApi(oldTools, f.framework);
    await oldApi.execute({ operation: 'create', directory: legacy, name: 'Existing project' });
    const description = join(legacy, '.dreamedge/project.json'); const original = await readFile(description, 'utf8'); const definition = JSON.parse(original);
    await writeFile(join(legacy, 'src/main.ts'), "document.body.textContent='Existing local edit';");
    await writeFile(join(legacy, '.dreamedge/model.json'), JSON.stringify({ schemaVersion: 1, apiKey: 'fixture-preserved-key', model: 'fixture', baseUrl: 'https://model.example/v1' }));
    const before = await readFile(join(legacy, '.git/HEAD'), 'utf8');
    const api = new WorkspaceApi(f.profile, f.framework); const opened = await api.execute({ operation: 'open', directory: legacy }) as WorkspaceProject;
    assert.equal(opened.definition.id, definition.id); assert.equal(await readFile(description, 'utf8'), original);
    assert.match(await readFile(join(opened.sourceDirectory, 'main.ts'), 'utf8'), /Existing local edit/);
    assert.match(await readFile(join(legacy, '.dreamedge/model.json'), 'utf8'), /fixture-preserved-key/);
    assert.equal(await readFile(join(legacy, '.git/HEAD'), 'utf8'), before);
    await api.execute({ operation: 'close' }); const reopened = await api.execute({ operation: 'open', directory: legacy }) as WorkspaceProject;
    assert.equal(reopened.definition.id, definition.id); assert.equal(reopened.rootDirectory, opened.rootDirectory);
    await assert.rejects(access(join(f.profile, 'project')));
  } finally { await f.cleanup(); }
});

test('a Git-synchronized business repository opens with its original identity/history on another DreamEdge profile', async () => {
  const f = await exportFixture();
  try {
    const clone = join(f.root, 'synced-business');
    await promisify(execFile)('git', ['clone', '--no-hardlinks', '--', f.project.rootDirectory, clone]);
    const profile = join(f.root, 'other-device'); await mkdir(profile);
    const api = new WorkspaceApi(profile, f.framework);
    const opened = await api.execute({ operation: 'open', directory: clone }) as WorkspaceProject;
    assert.equal(opened.definition.id, f.project.definition.id);
    assert.equal(await readFile(join(clone, '.git/HEAD'), 'utf8'), await readFile(join(f.project.rootDirectory, '.git/HEAD'), 'utf8'));
    const file = await api.execute({ operation: 'readFile', projectId: opened.definition.id, path: 'main.ts' }) as any;
    await api.execute({ operation: 'writeFile', projectId: opened.definition.id, path: 'main.ts', content: "document.body.textContent='Synced edit';", expectedHash: file.hash });
    assert.match(await readFile(join(clone, 'src/main.ts'), 'utf8'), /Synced edit/);
    assert.match(await readFile(join(f.project.sourceDirectory, 'main.ts'), 'utf8'), /HelloWorld/);
  } finally { await f.cleanup(); }
});
