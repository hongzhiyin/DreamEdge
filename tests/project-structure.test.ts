import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import type { CandidateInspection, GitStatus, WorkspaceStatus, DevelopmentTurn } from '../shared/contracts';
import { ResponsesModel } from '../desktop/development/responses';
import { ProjectGitApi } from '../desktop/git/api';
import { commitGit } from '../desktop/git/repository';
import { gitHistory } from '../desktop/git/history';
import { collectContext, validateProposal } from '../desktop/development/context';
import { settleInterruptedTurn } from '../desktop/development/settlement';
import { providerResponse } from './provider-fixture';
import { structureFixture, structureProposal } from './structure-fixture';

const call = (name: string, args: object) => ({ type: 'function_call', call_id: name, name, arguments: JSON.stringify(args) });
test('native pi tools stage exact npm dependencies and read-file deletion, apply atomically, and Git restores both', async () => {
  const f = await structureFixture(); const previousFetch = globalThis.fetch; let step = 0;
  const model = new ResponsesModel({ apiKey: 'fixture-structure-secret', model: 'test', baseUrl: 'https://model.example/v1' }, async (_url, options) => {
    const body = JSON.parse(String(options!.body));
    if (++step === 1) return providerResponse([call('read_file', { path: 'main.ts' }), { ...call('read_file', { path: 'unused.ts' }), call_id: 'read-unused' }]);
    if (step === 2) return providerResponse([call('resolve_dependency', { name: 'dreamedge-greeting', range: '*' })]);
    if (step === 3) { assert.ok(JSON.stringify(body.input).includes('1.0.0')); return providerResponse([call('set_dependencies', { packages: [{ name: 'dreamedge-greeting', version: '1.0.0' }] })]); }
    return providerResponse([call('propose_changes', structureProposal)]);
  });
  const git = new ProjectGitApi(f.workspace, f.profile);
  try {
    globalThis.fetch = async (url, options) => {
      assert.equal(String(url), 'https://registry.npmjs.org/dreamedge-greeting'); assert.equal(options?.redirect, 'error');
      assert.equal(new Headers(options?.headers).has('Authorization'), false);
      return Response.json({ versions: { '1.0.0': { ...f.item, dist: { tarball: f.item.tarball, integrity: f.item.integrity } } } });
    };
    await writeFile(join(f.project.dataDirectory, 'record.txt'), 'business data');
    await writeFile(join(f.project.rootDirectory, '.dreamedge/model.json'), 'private connection');
    f.provider.generate = (input, signal, tools) => model.generate(input, signal, tools);
    await f.send(); const turn = await f.settled(); assert.equal(turn.status, 'completed', turn.error ?? ''); assert.equal(turn.applied, true);
    assert.equal(step, 4); assert.deepEqual(turn.dependencies, { 'dreamedge-greeting': '1.0.0' });
    assert.deepEqual(turn.activity?.map(event => event.tool), ['read_file', 'read_file', 'resolve_dependency', 'set_dependencies']);
    await assert.rejects(access(join(f.project.sourceDirectory, 'unused.ts')));
    const current = (await f.workspace.execute({ operation: 'current' }) as WorkspaceStatus).project!;
    assert.equal(current.definition.dependencies['dreamedge-greeting'], '1.0.0');
    assert.equal(current.definition.dependencyLock!.packages['node_modules/dreamedge-greeting'].integrity, f.item.integrity);
    const candidate = await f.api.execute({ operation: 'candidate', projectId: current.definition.id, sessionId: f.session.id, turnId: turn.id }) as CandidateInspection;
    assert.equal(candidate.files[1].after, null); assert.match(candidate.files[1].before!, /unused/); assert.deepEqual(candidate.dependencies!.before, {});
    await commitGit(current.rootDirectory, 'After structure changes');
    const status = await git.execute({ operation: 'status', projectId: current.definition.id }) as GitStatus;
    await git.execute({ operation: 'restore', projectId: current.definition.id, commitId: f.baseline, expectedStateHash: status.stateHash });
    const restored = (await f.workspace.execute({ operation: 'current' }) as WorkspaceStatus).project!;
    assert.deepEqual(restored.definition.dependencies, {}); assert.equal(restored.definition.dependencyLock, undefined);
    assert.match(await readFile(join(restored.sourceDirectory, 'unused.ts'), 'utf8'), /old/);
    assert.equal(await readFile(join(restored.dataDirectory, 'record.txt'), 'utf8'), 'business data');
    assert.equal(await readFile(join(restored.rootDirectory, '.dreamedge/model.json'), 'utf8'), 'private connection');
    assert.equal((await gitHistory(restored.rootDirectory))[0].message, 'After structure changes');
  } finally { globalThis.fetch = previousFetch; await git.dispose(); await f.cleanup(); }
});
test('dependency-only turns build/apply, removal leaves source intact, and metadata-aware interruption recovery rejects unapplied builds', async () => {
  const f = await structureFixture();
  try {
    f.provider.generate = async (_input, signal, tools) => {
      await tools!.execute('set_dependencies', { packages: [{ name: 'dreamedge-greeting', version: '1.0.0' }] }, signal);
      return { summary: 'Add dependency only', files: [] };
    };
    const before = await readFile(join(f.project.sourceDirectory, 'main.ts'), 'utf8');
    await f.send(true); const turn = await f.settled(); assert.equal(turn.status, 'completed', turn.error ?? ''); assert.ok(turn.applied && turn.commitId);
    const current = (await f.workspace.execute({ operation: 'current' }) as WorkspaceStatus).project!;
    const recovered = { ...turn, status: 'running', phase: 'applying' } as DevelopmentTurn;
    await settleInterruptedTurn(current, recovered); assert.equal(recovered.applied, true);
    f.provider.generate = async (_input, signal, tools) => { await tools!.execute('set_dependencies', { packages: [] }, signal); return { summary: 'Remove dependency only', files: [] }; };
    await f.send(); const removed = await f.settled(); assert.equal(removed.status, 'completed', removed.error ?? '');
    assert.deepEqual(removed.dependencies, {}); assert.equal(await readFile(join(current.sourceDirectory, 'main.ts'), 'utf8'), before);
    const restored = (await f.workspace.execute({ operation: 'current' }) as WorkspaceStatus).project!;
    const abandoned = { ...turn, status: 'running', phase: 'applying' } as DevelopmentTurn;
    await settleInterruptedTurn(restored, abandoned); assert.equal(abandoned.applied, false); assert.equal(abandoned.status, 'interrupted');
  } finally { await f.cleanup(); }
});
test('broken imports or registry errors preserve removed files, original metadata and Git history', async () => {
  const f = await structureFixture();
  try {
    const before = await readFile(join(f.project.rootDirectory, '.dreamedge/project.json'), 'utf8');
    for (const version of ['1.0.0', '9.9.9']) {
      f.provider.generate = async (_input, signal, tools) => {
        await tools!.execute('set_dependencies', { packages: [{ name: 'dreamedge-greeting', version }] }, signal);
        return { ...structureProposal, files: [{ path: 'main.ts', content: 'const broken: = ;' }, structureProposal.files[1]] };
      };
      await f.send(true); const turn = await f.settled(); assert.equal(turn.status, 'failed'); assert.equal(turn.applied, false);
      assert.equal(await readFile(join(f.project.rootDirectory, '.dreamedge/project.json'), 'utf8'), before);
      await access(join(f.project.sourceDirectory, 'unused.ts')); assert.equal(turn.dependencies, undefined); assert.equal(turn.commitId, undefined);
    }
    assert.equal((await gitHistory(f.project.rootDirectory)).length, 2);
  } finally { await f.cleanup(); }
});
test('staged deletion/dependency candidates reject external edits and dependency overrides before building', async () => {
  const f = await structureFixture(false);
  try {
    f.provider.generate = async (_input, signal, tools) => { await tools!.execute('set_dependencies', { packages: [{ name: 'dreamedge-greeting', version: '1.0.0' }] }, signal); return structureProposal; };
    await f.api.execute({ operation: 'send', projectId: f.project.definition.id, sessionId: f.session.id, prompt: 'Stage', paths: ['main.ts', 'unused.ts'] });
    const turn = await f.settled(); const reference = { sessionId: f.session.id, turnId: turn.id };
    await assert.rejects(f.builds.execute({ operation: 'start', projectId: f.project.definition.id, candidate: reference, dependencies: {} }), /不能覆盖/);
    await writeFile(join(f.project.sourceDirectory, 'unused.ts'), 'user edit');
    await assert.rejects(f.builds.execute({ operation: 'start', projectId: f.project.definition.id, candidate: reference }), /过期/);
    assert.equal(await readFile(join(f.project.sourceDirectory, 'unused.ts'), 'utf8'), 'user edit');
  } finally { await f.cleanup(); }
});
test('deletion requires an existing read file and exact dependency declarations reject unsafe or conflicting inputs', async () => {
  const f = await structureFixture();
  try {
    const context = await collectContext(f.project, ['unused.ts']);
    for (const path of ['main.ts', 'missing.ts', '../outside', '.dreamedge/model.json']) {
      await assert.rejects(validateProposal(f.project, context, { summary: 'Delete', files: [{ path, content: null }] }));
    }
    const { dependencyList } = await import('../desktop/development/dependency-tools');
    for (const packages of [[{ name: 'react', version: '*' }], [{ name: 'react', version: 'file:/tmp/pkg' }],
      [{ name: 'react', version: '1.0.0' }, { name: 'react', version: '2.0.0' }], [{ name: '../unsafe', version: '1.0.0' }]]) assert.throws(() => dependencyList(packages));
    const valid = await validateProposal(f.project, context, { summary: 'Delete', files: [{ path: 'unused.ts', content: null }] });
    assert.equal(valid.changes[0].content, null); assert.ok(valid.changes[0].expectedHash);
    await writeFile(join(f.project.sourceDirectory, 'unused.ts'), 'changed');
    await assert.rejects(validateProposal(f.project, context, { summary: 'Delete', files: [{ path: 'unused.ts', content: null }] }), /变化/);
  } finally { await f.cleanup(); }
});
