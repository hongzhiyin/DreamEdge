import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, readFile, writeFile, access, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { ProjectExport, ExportStatus, WorkspaceProject } from '../shared/contracts';
import { exportFixture } from './export-fixture';
import { deferred } from './development-fixture';
import { ProjectExports } from '../desktop/export/api';
import { compile } from '../desktop/build/compiler';
import { exportedManifest } from '../desktop/export/stage';
import { hash } from '../desktop/workspace/paths';

test('export includes source, framework packages and app identity while excluding connection, history and data', async () => {
  const f = await exportFixture();
  try {
    await writeFile(join(f.project.rootDirectory, '.dreamedge/model.json'), 'fixture-private-key'); await writeFile(join(f.project.dataDirectory, 'data.txt'), 'business-data');
    await f.workspace.execute({ operation: 'save', projectId: f.project.definition.id, appId: 'io.example.fixture', version: '1.2.3' });
    const record = await f.exports.execute({ operation: 'start', projectId: f.project.definition.id, directory: join(f.root, 'output') }) as ProjectExport;
    const result = await f.settled(record.id); assert.equal(result.status, 'succeeded', result.error ?? '');
    const source = join(result.directory, '工程'); const definition = JSON.parse(await readFile(join(source, '.dreamedge/project.json'), 'utf8'));
    assert.notEqual(definition.id, f.project.definition.id); assert.equal(definition.appId, 'io.example.fixture'); assert.equal(definition.version, '1.2.3');
    assert.match(await readFile(join(source, 'src/main.ts'), 'utf8'), /HelloWorld/);
    assert.equal(await readFile(join(source, 'framework/dreamedge-sdk-0.1.1.tgz'), 'utf8'), 'framework-sdk');
    for (const path of ['.dreamedge/model.json', '.git', 'data', 'sessions', 'build']) await assert.rejects(access(join(source, path)));
    const resumed = new ProjectExports(f.workspace, f.profile, f.framework, f.resources, f.builds, async () => {}, true, async () => {});
    assert.equal(((await resumed.execute({ operation: 'current', projectId: f.project.definition.id })) as ExportStatus).record?.id, record.id); await resumed.dispose();
  } finally { await f.cleanup(); }
});
test('export rejects protected/existing destinations without overwriting unrelated files', async () => {
  const f = await exportFixture();
  try {
    await mkdir(join(f.root, 'existing')); await writeFile(join(f.root, 'existing/user.txt'), 'keep');
    for (const directory of [f.framework, f.profile, f.project.rootDirectory, join(f.project.sourceDirectory, 'export'), join(f.root, 'existing')])
      await assert.rejects(f.exports.execute({ operation: 'start', projectId: f.project.definition.id, directory }));
    assert.equal(await readFile(join(f.root, 'existing/user.txt'), 'utf8'), 'keep');
  } finally { await f.cleanup(); }
});
test('cancellation and source conflicts prevent publishing and preserve original source', async () => {
  const ready = deferred<void>(); const resume = deferred<void>(); const f = await exportFixture(async (_input, signal) => { ready.resolve(); await resume.promise; signal.throwIfAborted(); });
  try {
    const started = await f.exports.execute({ operation: 'start', projectId: f.project.definition.id, directory: join(f.root, 'cancelled') }) as ProjectExport;
    await ready.promise; const cancel = f.exports.execute({ operation: 'cancel', projectId: f.project.definition.id, exportId: started.id }); resume.resolve();
    assert.equal((await cancel as ProjectExport).status, 'cancelled'); await assert.rejects(access(join(f.root, 'cancelled')));
    const g = await exportFixture(async () => { await writeFile(join(g.project.sourceDirectory, 'main.ts'), 'external-edit'); });
    try {
      const record = await g.exports.execute({ operation: 'start', projectId: g.project.definition.id, directory: join(g.root, 'conflict') }) as ProjectExport;
      assert.equal((await g.settled(record.id)).status, 'failed'); await assert.rejects(access(join(g.root, 'conflict')));
      assert.equal(await readFile(join(g.project.sourceDirectory, 'main.ts'), 'utf8'), 'external-edit');
    } finally { await g.cleanup(); }
  } finally { resume.resolve(); await f.cleanup(); }
});
test('application settings guard stale revisions and allow identity restore within the same project', async () => {
  const f = await exportFixture();
  try {
    const revision = hash(JSON.stringify(f.project.definition));
    await f.workspace.execute({ operation: 'save', projectId: f.project.definition.id, appId: 'io.example.changed', expectedDefinitionHash: revision });
    await assert.rejects(f.workspace.execute({ operation: 'save', projectId: f.project.definition.id, name: 'stale', expectedDefinitionHash: revision }), /变化/);
    for (const appId of ['invalid', 'io.Example.app', '../escape']) await assert.rejects(f.workspace.execute({ operation: 'save', projectId: f.project.definition.id, appId }));
    await assert.rejects(f.workspace.execute({ operation: 'save', projectId: f.project.definition.id, version: '01.0.0' }));
    const { ProjectGitApi } = await import('../desktop/git/api'); const git = new ProjectGitApi(f.workspace, f.profile);
    const status = await git.execute({ operation: 'status', projectId: f.project.definition.id }) as any; const baseline = status.commits[0].id;
    await git.execute({ operation: 'commit', projectId: f.project.definition.id, message: 'Change identity', expectedStateHash: status.stateHash });
    const after = await git.execute({ operation: 'status', projectId: f.project.definition.id }) as any;
    await git.execute({ operation: 'restore', projectId: f.project.definition.id, commitId: baseline, expectedStateHash: after.stateHash });
    const current = (await f.workspace.execute({ operation: 'current' })) as { project: WorkspaceProject }; assert.equal(current.project.definition.appId, f.project.definition.appId); await git.dispose();
  } finally { await f.cleanup(); }
});
test('browser SDK is built in without a registry declaration and app namespace is stable across source clone IDs', async () => {
  const f = await exportFixture();
  try {
    const output = await compile({ files: { 'index.html': '<div id="root"></div><script type="module" src="./main.ts"></script>',
      'main.ts': "import {storage} from '@dreamedge/sdk';await storage.put('records','id','value');document.getElementById('root')!.textContent='SDK';" } });
    assert.ok(Object.values(output.files).some(file => file.includes('dreamedge:bridge')));
    const a = exportedManifest({ files: {}, outputs: {}, definition: f.project.definition });
    const b = exportedManifest({ files: {}, outputs: {}, definition: { ...f.project.definition, id: crypto.randomUUID() } }); assert.equal(a.id, b.id);
    assert.throws(() => exportedManifest({ files: {}, outputs: {}, definition: { ...f.project.definition, name: '../bad' } }));
  } finally { await f.cleanup(); }
});

test('export blocks known connection credentials in source and foreign export references', async () => {
  const f = await exportFixture();
  try {
    const guarded = new ProjectExports(f.workspace, f.profile, f.framework, f.resources, f.builds, async () => {}, true, async () => {}, async snapshot => {
      if (Object.values(snapshot.files).some(text => text.includes('known-private-key'))) throw new Error('源码包含连接凭据。');
    });
    await writeFile(join(f.project.sourceDirectory, 'main.ts'), "document.body.textContent='known-private-key';");
    const record = await guarded.execute({ operation: 'start', projectId: f.project.definition.id, directory: join(f.root, 'blocked') }) as ProjectExport;
    let result = record; while (result.status === 'running') { await new Promise(resolve => setTimeout(resolve, 10)); result = await guarded.execute({ operation: 'get', projectId: f.project.definition.id, exportId: record.id }) as ProjectExport; }
    assert.equal(result.status, 'failed'); await assert.rejects(access(join(f.root, 'blocked')));
    const other = await f.workspace.execute({ operation: 'create', directory: join(f.root, 'other'), name: 'Other' }) as WorkspaceProject;
    await assert.rejects(guarded.execute({ operation: 'get', projectId: other.definition.id, exportId: record.id }), /不属于/);
    await guarded.dispose();
  } finally { await f.cleanup(); }
});
