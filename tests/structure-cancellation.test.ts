import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { WorkspaceProject } from '../shared/contracts';
import { SessionStore } from '../desktop/development/sessions';
import { deferred } from './development-fixture';
import { structureFixture, structureProposal } from './structure-fixture';
import { candidateDiff } from '../shell/candidate-diff';

test('npm lookups release the workspace queue; cancellation rejects late metadata without modifying source', async () => {
  const f = await structureFixture(); const originalFetch = globalThis.fetch;
  const ready = deferred<void>(); const response = deferred<Response>();
  try {
    const before = await readFile(join(f.project.sourceDirectory, 'unused.ts'), 'utf8');
    globalThis.fetch = async () => { ready.resolve(); return response.promise; };
    f.provider.generate = async (_input, signal, tools) => {
      await tools!.execute('resolve_dependency', { name: 'dreamedge-greeting', range: '*' }, signal);
      await tools!.execute('set_dependencies', { packages: [{ name: 'dreamedge-greeting', version: '1.0.0' }] }, signal);
      return structureProposal;
    };
    await f.send(); await ready.promise;
    const cancelled = await Promise.race([f.api.execute({ operation: 'cancel', projectId: f.project.definition.id, sessionId: f.session.id }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Lookup blocked cancellation')), 1000))]);
    assert.ok('turns' in cancelled); assert.equal(cancelled.turns.at(-1)?.status, 'cancelled');
    response.resolve(Response.json({ versions: {} }));
    assert.equal(await readFile(join(f.project.sourceDirectory, 'unused.ts'), 'utf8'), before);
    const current = await f.workspace.withProject(f.project.definition.id, async project => project); assert.deepEqual(current.definition.dependencies, {});
  } finally { response.resolve(Response.json({ versions: {} })); globalThis.fetch = originalFetch; await f.cleanup(); }
});
test('late npm lookup after switching projects cannot declare dependencies or delete the new project source', async () => {
  const f = await structureFixture(); const originalFetch = globalThis.fetch;
  const ready = deferred<void>(); const response = deferred<Response>();
  try {
    globalThis.fetch = async () => { ready.resolve(); return response.promise; };
    f.provider.generate = async (_input, signal, tools) => { await tools!.execute('resolve_dependency', { name: 'dreamedge-greeting', range: '*' }, signal); return structureProposal; };
    await f.send(); await ready.promise;
    const other = await f.workspace.execute({ operation: 'create', directory: join(f.root, 'other'), name: 'Other' }) as WorkspaceProject;
    response.resolve(Response.json({ versions: { '1.0.0': { ...f.item, dist: { tarball: f.item.tarball, integrity: f.item.integrity } } } }));
    const store = new SessionStore(); const deadline = Date.now() + 2000;
    while ((await store.load(f.project, f.session.id)).turns.at(-1)?.status === 'running' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal((await store.load(f.project, f.session.id)).turns.at(-1)?.status, 'failed');
    assert.deepEqual((await f.workspace.withProject(other.definition.id, async project => project)).definition.dependencies, {});
    assert.match(await readFile(join(other.sourceDirectory, 'main.ts'), 'utf8'), /HelloWorld/);
    assert.match(await readFile(join(f.project.sourceDirectory, 'unused.ts'), 'utf8'), /old/);
  } finally { response.resolve(Response.json({ versions: {} })); globalThis.fetch = originalFetch; await f.cleanup(); }
});
test('cancelling dependency preparation prevents both deletion and declarations from being applied', async () => {
  const ready = deferred<void>(); const resume = deferred<void>();
  const f = await structureFixture(true, async (_project, _root, declared, signal) => {
    assert.equal(declared['dreamedge-greeting'], '1.0.0'); ready.resolve(); await resume.promise;
    signal.throwIfAborted(); throw new Error('Cancelled preparation must not finish');
  });
  try {
    f.provider.generate = async (_input, signal, tools) => { await tools!.execute('set_dependencies', { packages: [{ name: 'dreamedge-greeting', version: '1.0.0' }] }, signal); return structureProposal; };
    const before = await readFile(join(f.project.rootDirectory, '.dreamedge/project.json'), 'utf8');
    await f.send(); await ready.promise;
    await f.api.execute({ operation: 'cancel', projectId: f.project.definition.id, sessionId: f.session.id }); resume.resolve();
    const turn = await f.settled(); assert.equal(turn.status, 'cancelled'); assert.equal(turn.applied, false);
    assert.equal(await readFile(join(f.project.rootDirectory, '.dreamedge/project.json'), 'utf8'), before);
    assert.match(await readFile(join(f.project.sourceDirectory, 'unused.ts'), 'utf8'), /old/);
  } finally { resume.resolve(); await f.cleanup(); }
});
test('external edits while resolving a dependency build cannot be removed by late application', async () => {
  const ready = deferred<void>(); const resume = deferred<void>();
  const f = await structureFixture(true, async (_project, _root, declared, signal) => {
    ready.resolve(); await resume.promise; signal.throwIfAborted();
    return { lock: { schemaVersion: 1, registry: 'https://registry.npmjs.org', dependencies: declared, packages: {} }, files: {} };
  });
  try {
    f.provider.generate = async (_input, signal, tools) => { await tools!.execute('set_dependencies', { packages: [] }, signal); return { summary: 'Delete unused', files: [structureProposal.files[1]] }; };
    await f.send(); await ready.promise;
    await writeFile(join(f.project.sourceDirectory, 'unused.ts'), 'User edit during build'); resume.resolve();
    assert.equal((await f.settled()).status, 'failed');
    assert.equal(await readFile(join(f.project.sourceDirectory, 'unused.ts'), 'utf8'), 'User edit during build');
  } finally { resume.resolve(); await f.cleanup(); }
});
test('deletion diff distinguishes a removed file from an empty replacement', () => {
  assert.deepEqual(candidateDiff('old', null), [{ kind: 'removed', text: 'old' }]);
  assert.deepEqual(candidateDiff('old', ''), [{ kind: 'removed', text: 'old' }, { kind: 'added', text: '' }]);
});
