import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, readFile, writeFile, symlink, rm, access, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import type { AppManifest, ProjectExport, WorkspaceProject, DependencyLock } from '../shared/contracts';
import { exportFixture } from './export-fixture';
import { copyResource } from '../desktop/export/resources';
import { prepareEmbeddedProject } from '../desktop/embedded/project';
import { readLockedArchives, archiveNames, installLockedArchives } from '../desktop/embedded/dependencies';
import { WorkspaceApi } from '../desktop/workspace/api';
import { SavedProjectDisplay } from '../desktop/display/current';
import { WindowContext } from '../desktop/windows/context';
import { WindowState } from '../desktop/windows/state';
import { WorkspaceRegistry } from '../desktop/workspace/registry';
import { Capacity } from '../desktop/windows/capacity';
import { compile } from '../desktop/build/compiler';
import { validateManifest } from '../desktop/project';
import { dependencyPreparer } from '../desktop/dependencies/prepare';
import { packageRegistry } from './dependency-fixture';

async function fixture() {
  let manifest: AppManifest;
  const f = await exportFixture(async input => { manifest = input.manifest; await copyResource(join(input.root, 'application'), join(f.root, 'installed')); });
  const record = await f.exports.execute({ operation: 'start', projectId: f.project.definition.id, mode: 'development', directory: join(f.root, 'export') }) as ProjectExport;
  const result = await f.settled(record.id); assert.equal(result.status, 'succeeded', result.error ?? '');
  const app = join(f.root, 'installed'); const profile = join(f.root, 'app-profile'); await mkdir(profile);
  return { ...f, app, appProfile: profile, manifest: manifest! };
}
test('development export includes only seed source and trusted tools, bootstraps Git outside App, and uses offline checked output', async () => {
  const f = await fixture(); let display: SavedProjectDisplay | undefined;
  try {
    assert.deepEqual(f.manifest.capabilities, ['storage', 'workspace']); assert.equal(f.manifest.development?.frameworkVersion, '0.1.1');
    assert.equal(JSON.parse(await readFile(join(f.root, 'export/export.json'), 'utf8')).mode, 'development');
    for (const path of ['dist/framework/tooling/package.json', 'dist/framework/bundles/dreamedge-sdk-0.1.1.tgz', 'dist/runtime/export-worker.cjs']) await access(join(f.app, path));
    for (const path of ['dist/development/.dreamedge/model.json', 'dist/development/.git', 'dist/development/data']) await assert.rejects(access(join(f.app, path)));
    const project = (await prepareEmbeddedProject(f.app, f.appProfile, f.app, f.manifest))!;
    assert.equal(project.rootDirectory, join(await realpath(f.appProfile), 'project'));
    assert.notEqual(project.definition.id, f.project.definition.id); await access(join(project.rootDirectory, '.git'));
    const api = new WorkspaceApi(f.appProfile, f.app, undefined, { rootDirectory: project.rootDirectory, appId: f.manifest.appId, projectId: project.definition.id });
    display = new SavedProjectDisplay(api, async () => { throw new Error('Offline first launch must not compile'); }, new Capacity(2, 'Busy'), () => {}, async () => { throw new Error('Offline first launch must not download'); });
    display.refresh(); const deadline = Date.now() + 3000;
    while (display.status?.status === 'loading' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(display.status?.status, 'ready', display.status?.error ?? '');
    await assert.rejects(api.execute({ operation: 'create', directory: join(f.root, 'other'), name: 'Other' }), /绑定|自身/);
    await assert.rejects(api.execute({ operation: 'open', directory: f.project.rootDirectory }), /自身/);
    await assert.rejects(api.execute({ operation: 'close' }), /绑定/);
    await assert.rejects(api.execute({ operation: 'save', projectId: project.definition.id, appId: 'io.other.app' }), /标识/);
  } finally { await display?.dispose(); await f.cleanup(); }
});
test('upgraded seed never replaces local edits, project identity, model configuration or Git', async () => {
  const f = await fixture();
  try {
    const project = (await prepareEmbeddedProject(f.app, f.appProfile, f.app, f.manifest))!;
    await writeFile(join(project.rootDirectory, 'src/main.ts'), "document.body.textContent='Local edit';");
    await writeFile(join(project.rootDirectory, '.dreamedge/model.json'), 'local-private-configuration');
    const git = await readFile(join(project.rootDirectory, '.git/HEAD'), 'utf8');
    const seed = join(f.app, 'dist/development/.dreamedge/project.json'); const next = JSON.parse(await readFile(seed, 'utf8')); next.id = crypto.randomUUID(); next.version = '2.0.0';
    await writeFile(seed, JSON.stringify(next)); await writeFile(join(f.app, 'dist/development/src/main.ts'), "document.body.textContent='Publisher v2';");
    const upgraded = (await prepareEmbeddedProject(f.app, f.appProfile, f.app, { ...f.manifest, version: '2.0.0' }))!;
    assert.equal(upgraded.definition.id, project.definition.id); assert.equal(upgraded.definition.version, project.definition.version);
    assert.match(await readFile(join(upgraded.sourceDirectory, 'main.ts'), 'utf8'), /Local edit/);
    assert.equal(await readFile(join(upgraded.rootDirectory, '.dreamedge/model.json'), 'utf8'), 'local-private-configuration');
    assert.equal(await readFile(join(upgraded.rootDirectory, '.git/HEAD'), 'utf8'), git);
  } finally { await f.cleanup(); }
});
test('invalid development manifests, linked/malformed workspaces and export modes cannot overwrite existing data', async () => {
  const f = await fixture();
  try {
    assert.throws(() => validateManifest({ ...f.manifest, capabilities: ['storage'] }), /开发版/);
    assert.throws(() => validateManifest({ ...f.manifest, development: { ...f.manifest.development, project: '../escape' } }), /开发版/);
    await mkdir(join(f.root, 'outside')); await writeFile(join(f.root, 'outside/keep'), 'preserve');
    await symlink(join(f.root, 'outside'), join(f.appProfile, 'project'));
    await assert.rejects(prepareEmbeddedProject(f.app, f.appProfile, f.app, f.manifest), /符号链接/);
    assert.equal(await readFile(join(f.root, 'outside/keep'), 'utf8'), 'preserve');
    await rm(join(f.appProfile, 'project')); await mkdir(join(f.appProfile, 'project')); await writeFile(join(f.appProfile, 'project/keep'), 'keep');
    await assert.rejects(prepareEmbeddedProject(f.app, f.appProfile, f.app, f.manifest));
    assert.equal(await readFile(join(f.appProfile, 'project/keep'), 'utf8'), 'keep');
    await assert.rejects(f.exports.execute({ operation: 'start', projectId: f.project.definition.id, mode: 'other', directory: join(f.root, 'bad-mode') }), /模式/);
    await assert.rejects(access(join(f.root, 'bad-mode')));
  } finally { await f.cleanup(); }
});
test('standard → development → standard use the same business namespace while other Apps remain isolated', async () => {
  const f = await fixture(); const contexts: WindowContext[] = [];
  try {
    const catalog = new WorkspaceRegistry(f.appProfile); const windows = new WindowState(f.appProfile); const capacity = new Capacity(2, 'Busy');
    await Promise.all([catalog.ready, windows.ready]);
    async function context(manifest: AppManifest, project?: WorkspaceProject) {
      const record = await windows.allocate(project ? { id: project.definition.id, root: project.rootDirectory } : null);
      const item = new WindowContext({ id: record.id, manifest, profile: f.appProfile, root: f.app, frameworkRoot: f.app, catalog, windows,
        engine: input => compile(input), boundProject: project, buildCapacity: capacity, openPreview: async () => {}, changed: () => {}, closePreviews: () => {} });
      contexts.push(item); await item.ready(); return item;
    }
    const plain = { ...f.manifest, development: undefined, capabilities: ['storage'] };
    const before = await context(plain); await before.storage(before.tools()[0].id, { operation: 'put', collection: 'check', id: 'record', value: 'v1' }); await before.dispose();
    const project = (await prepareEmbeddedProject(f.app, f.appProfile, f.app, f.manifest))!; const editable = await context(f.manifest, project);
    const tool = editable.tools()[0]; assert.deepEqual(await editable.storage(tool.id, { operation: 'list', collection: 'check' }, tool.contextId), [{ id: 'record', value: 'v1' }]);
    await editable.storage(tool.id, { operation: 'put', collection: 'check', id: 'record', value: 'v2' }, tool.contextId); await editable.dispose();
    const after = await context(plain); assert.deepEqual(await after.storage(after.tools()[0].id, { operation: 'list', collection: 'check' }), [{ id: 'record', value: 'v2' }]);
    const other = await context({ ...plain, id: 'other', appId: 'io.other.app' });
    assert.deepEqual(await other.storage(other.tools()[0].id, { operation: 'list', collection: 'check' }), []);
  } finally { await Promise.all(contexts.map(item => item.dispose())); await f.cleanup(); }
});
test('only integrity-checked locked dependency archives are seeded; tampering and links are refused', async () => {
  const f = await fixture();
  try {
    const registry = await packageRegistry(); const item = await registry.add('tiny', '1.0.0', { 'index.js': "export const value='offline';" });
    const lock: DependencyLock = { schemaVersion: 1, registry: 'https://registry.npmjs.org', dependencies: { tiny: '1.0.0' }, packages: { 'node_modules/tiny': item } };
    const cache = join(f.root, 'cache'); await mkdir(cache); const name = [...archiveNames(lock).keys()][0];
    await writeFile(join(cache, name), registry.archives.get(item.tarball)!);
    const archives = await readLockedArchives(cache, lock); assert.equal(Object.keys(archives).length, 1);
    const project = (await prepareEmbeddedProject(f.app, f.appProfile, f.app, f.manifest))!;
    project.definition.dependencies = lock.dependencies; project.definition.dependencyLock = lock; await installLockedArchives(cache, project);
    assert.deepEqual(await readFile(join(project.buildDirectory, '.dependency-cache', name)), archives[name]);
    registry.offline();
    const staging = join(f.root, 'offline-build'); await mkdir(staging);
    const prepared = await dependencyPreparer(registry.registry)(project, staging, lock.dependencies, new AbortController().signal, async () => {});
    const output = await compile({ files: { 'index.html': '<div id="root"></div><script type="module" src="./main.ts"></script>', 'main.ts': "import {value} from 'tiny';document.body.textContent=value;" }, dependencyFiles: prepared.files, dependencyLock: prepared.lock });
    assert.ok(Object.values(output.files).some(text => text.includes('offline'))); assert.deepEqual(registry.stats(), { resolves: 0, downloads: 0 });
    await writeFile(join(cache, name), 'tampered'); await assert.rejects(readLockedArchives(cache, lock), /完整性/);
    await rm(join(cache, name)); await symlink(join(f.root, 'outside'), join(cache, name)); await assert.rejects(readLockedArchives(cache, lock), /符号链接/);
  } finally { await f.cleanup(); }
});
