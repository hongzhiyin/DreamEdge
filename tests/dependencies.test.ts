import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { CandidateBuild, GitStatus, WorkspaceProject } from '../shared/contracts';
import { CandidateBuildApi } from '../desktop/build/api';
import { compile } from '../desktop/build/compiler';
import { dependencyPreparer, type PreparedDependencies } from '../desktop/dependencies/prepare';
import { verifyArchive } from '../desktop/dependencies/registry';
import { ProjectGitApi } from '../desktop/git/api';
import { Capacity } from '../desktop/windows/capacity';
import { fixture, deferred, proposal } from './development-fixture';
import { packageRegistry } from './dependency-fixture';

async function settled(api: CandidateBuildApi, id: string, buildId: string) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const record = await api.execute({ operation: 'get', projectId: id, buildId }) as CandidateBuild;
    if (record.status !== 'running') return record;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Dependency build did not settle');
}
test('dependency candidate is isolated, locks on confirmation, rebuilds offline and restores lock with source versions', async () => {
  const f = await fixture(async () => ({ summary: 'Dependency greeting', files: [{ path: 'src/main.ts',
    content: "import { message } from 'greeting';document.body.textContent=message;" }] })); const registry = await packageRegistry();
  await registry.add('greeting', '1.0.0', { 'index.js': "import { suffix } from 'shared';export const message='HelloWorld'+suffix;" }, { shared: '^1.0.0' });
  await registry.add('shared', '1.0.0', { 'index.js': "export const suffix=' dependencies';" });
  const api = new CandidateBuildApi(f.workspace, input => compile(input), async () => {}, 5000, new Capacity(2, 'Busy'), dependencyPreparer(registry.registry));
  const versions = new ProjectGitApi(f.workspace, f.profile);
  try {
    await f.send(); const session = await f.settled();
    const candidate = { sessionId: session.id, turnId: session.turns[0].id };
    const started = await api.execute({ operation: 'start', projectId: f.project.definition.id, candidate, dependencies: { greeting: '1.0.0' } }) as CandidateBuild;
    const record = await settled(api, f.project.definition.id, started.id);
    assert.equal(record.status, 'succeeded', JSON.stringify(record.logs));
    assert.deepEqual(JSON.parse(await readFile(join(f.project.rootDirectory, '.dreamedge/project.json'), 'utf8')).dependencies, {});
    assert.match(await readFile(join(f.project.buildDirectory, record.id, 'output/__dreamedge_bundle/module0.js'), 'utf8'), /dependencies/);
    const original = await versions.execute({ operation: 'status', projectId: f.project.definition.id }) as GitStatus;
    await versions.execute({ operation: 'applyBuild', projectId: f.project.definition.id, buildId: record.id });
    const applied = await versions.execute({ operation: 'status', projectId: f.project.definition.id }) as GitStatus;
    await versions.execute({ operation: 'commit', projectId: f.project.definition.id, expectedStateHash: applied.stateHash, message: 'Lock dependencies' });
    const current = (await f.workspace.execute({ operation: 'current' }) as { project: WorkspaceProject }).project;
    assert.equal(current.definition.dependencies.greeting, '1.0.0'); assert.equal(Object.keys(current.definition.dependencyLock!.packages).length, 2);
    const requests = registry.stats(); registry.offline();
    const rebuild = await api.execute({ operation: 'start', projectId: f.project.definition.id }) as CandidateBuild;
    const second = await settled(api, f.project.definition.id, rebuild.id);
    assert.equal(second.status, 'succeeded'); assert.deepEqual(second.outputHashes, record.outputHashes); assert.deepEqual(registry.stats(), requests);
    const cache = join(f.project.buildDirectory, '.dependency-cache', createHash('sha256').update(current.definition.dependencyLock!.packages['node_modules/greeting'].integrity).digest('hex') + '.tgz');
    await writeFile(cache, 'tampered');
    const broken = await api.execute({ operation: 'start', projectId: f.project.definition.id }) as CandidateBuild;
    const failure = await settled(api, f.project.definition.id, broken.id);
    assert.equal(failure.status, 'failed'); assert.match(failure.logs.at(-1)!.message, /完整性/);
    await api.execute({ operation: 'clearDependencyCache', projectId: f.project.definition.id });
    const status = await versions.execute({ operation: 'status', projectId: f.project.definition.id }) as GitStatus;
    await versions.execute({ operation: 'restore', projectId: f.project.definition.id, commitId: original.head!, expectedStateHash: status.stateHash });
    assert.deepEqual(JSON.parse(await readFile(join(f.project.rootDirectory, '.dreamedge/project.json'), 'utf8')).dependencies, {});
    assert.match(await readFile(join(f.project.sourceDirectory, 'main.ts'), 'utf8'), /HelloWorld/);
  } finally { await api.dispose(); await versions.dispose(); await f.cleanup(); }
});
test('cancellation during dependency resolution cannot publish or modify the source project', async () => {
  const f = await fixture(async () => proposal); const waiting = deferred<never>();
  const api = new CandidateBuildApi(f.workspace, input => compile(input), async () => {}, 2000, new Capacity(2, 'Busy'), async () => waiting.promise);
  try {
    const before = await readFile(join(f.project.rootDirectory, '.dreamedge/project.json'), 'utf8');
    const started = await api.execute({ operation: 'start', projectId: f.project.definition.id, dependencies: { greeting: '1.0.0' } }) as CandidateBuild;
    await assert.rejects(api.execute({ operation: 'clearDependencyCache', projectId: f.project.definition.id }), /构建期间/);
    const cancelled = await api.execute({ operation: 'cancel', projectId: f.project.definition.id, buildId: started.id }) as CandidateBuild;
    assert.equal(cancelled.status, 'cancelled'); assert.equal(await readFile(join(f.project.rootDirectory, '.dreamedge/project.json'), 'utf8'), before);
    assert.throws(() => verifyArchive(Buffer.from('tampered'), 'sha512-' + 'A'.repeat(86) + '=='), /完整性/);
  } finally { await api.dispose(); await f.cleanup(); }
});
test('tampered candidate dependency metadata never passes preview or confirmation checks', async () => {
  const f = await fixture(async () => proposal);
  const api = new CandidateBuildApi(f.workspace, input => compile(input), async () => {}); const versions = new ProjectGitApi(f.workspace, f.profile);
  try {
    const started = await api.execute({ operation: 'start', projectId: f.project.definition.id }) as CandidateBuild;
    const record = await settled(api, f.project.definition.id, started.id);
    await writeFile(join(f.project.buildDirectory, record.id, 'candidate-definition.json'), '{}');
    await assert.rejects(api.execute({ operation: 'openPreview', projectId: f.project.definition.id, buildId: record.id }), /锁定已变化/);
    await assert.rejects(versions.execute({ operation: 'applyBuild', projectId: f.project.definition.id, buildId: record.id }), /锁定已变化/);
  } finally { await api.dispose(); await versions.dispose(); await f.cleanup(); }
});

test('source edits during dependency preparation reject the late candidate while preserving those edits', async () => {
  const f = await fixture(async () => proposal); const prepared = deferred<PreparedDependencies>();
  const api = new CandidateBuildApi(f.workspace, input => compile(input), async () => {}, 2000, new Capacity(2, 'Busy'), async () => prepared.promise);
  try {
    const started = await api.execute({ operation: 'start', projectId: f.project.definition.id }) as CandidateBuild;
    await writeFile(join(f.project.sourceDirectory, 'main.ts'), "document.body.textContent='User edit';");
    prepared.resolve({ files: {}, lock: { schemaVersion: 1, registry: 'https://registry.npmjs.org', dependencies: {}, packages: {} } });
    const result = await settled(api, f.project.definition.id, started.id);
    assert.equal(result.status, 'failed'); assert.equal(result.previewUrl, null);
    assert.match(result.logs.at(-1)!.message, /源工程已变化/);
    assert.match(await readFile(join(f.project.sourceDirectory, 'main.ts'), 'utf8'), /User edit/);
  } finally { await api.dispose(); await f.cleanup(); }
});
