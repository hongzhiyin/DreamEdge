import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DevelopmentSession } from '../shared/contracts';
import { DevelopmentApi } from '../desktop/development/api';
import { AutomaticEdits } from '../desktop/development/apply';
import { CandidateBuildApi } from '../desktop/build/api';
import { compile } from '../desktop/build/compiler';
import { gitStatus } from '../desktop/git/repository';
import { gitHistory } from '../desktop/git/history';
import { fixture, proposal, deferred } from './development-fixture';

async function wait(api: DevelopmentApi, projectId: string, sessionId: string) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const value = await api.execute({ operation: 'get', projectId, sessionId }) as DevelopmentSession;
    if (value.turns.at(-1)?.status !== 'running') return value.turns.at(-1)!;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Automatic edit timed out');
}
test('AI changes automatically compile and apply, leaving Git changes uncommitted by default', async () => {
  const f = await fixture(async () => proposal); let refreshed = 0;
  const builds = new CandidateBuildApi(f.workspace, input => compile(input), async () => {});
  const api = new DevelopmentApi(f.workspace, f.provider, 5000, new AutomaticEdits(f.workspace, f.profile, builds, () => refreshed++));
  try {
    await api.execute({ operation: 'send', projectId: f.project.definition.id, sessionId: f.session.id, prompt: 'Change', paths: ['src/main.ts'] });
    const turn = await wait(api, f.project.definition.id, f.session.id);
    assert.equal(turn.status, 'completed', turn.error ?? ''); assert.equal(turn.applied, true); assert.equal(refreshed, 1);
    assert.equal(await readFile(join(f.project.sourceDirectory, 'main.ts'), 'utf8'), proposal.files[0].content);
    assert.equal((await gitHistory(f.project.rootDirectory)).length, 1); assert.ok((await gitStatus(f.project.rootDirectory)).changed.length);
    assert.equal((await api.execute({ operation: 'candidate', projectId: f.project.definition.id, sessionId: f.session.id, turnId: turn.id }) as { stale: boolean }).stale, false);
  } finally { await api.dispose(); await builds.dispose(); await f.cleanup(); }
});
test('a compiler failure preserves all source and produces no Git commit', async () => {
  const f = await fixture(async () => ({ summary: 'Broken', files: [{ path: 'src/main.ts', content: 'const broken: = ;' }] }));
  const builds = new CandidateBuildApi(f.workspace, input => compile(input), async () => {});
  const api = new DevelopmentApi(f.workspace, f.provider, 5000, new AutomaticEdits(f.workspace, f.profile, builds, () => {}));
  try {
    const original = await readFile(join(f.project.sourceDirectory, 'main.ts'), 'utf8');
    await api.execute({ operation: 'send', projectId: f.project.definition.id, sessionId: f.session.id, prompt: 'Change', paths: ['src/main.ts'], commit: true });
    const turn = await wait(api, f.project.definition.id, f.session.id);
    assert.equal(turn.status, 'failed'); assert.equal(turn.applied, false);
    assert.equal(await readFile(join(f.project.sourceDirectory, 'main.ts'), 'utf8'), original); assert.equal((await gitHistory(f.project.rootDirectory)).length, 1);
  } finally { await api.dispose(); await builds.dispose(); await f.cleanup(); }
});
test('cancelling an automatic build settles without writing source even if the compiler returns late', async () => {
  const f = await fixture(async () => proposal); const output = deferred<ReturnType<typeof compile> extends Promise<infer T> ? T : never>(); let compiling = false;
  const builds = new CandidateBuildApi(f.workspace, async () => { compiling = true; return output.promise; }, async () => {});
  const api = new DevelopmentApi(f.workspace, f.provider, 5000, new AutomaticEdits(f.workspace, f.profile, builds, () => {}));
  try {
    const original = await readFile(join(f.project.sourceDirectory, 'main.ts'), 'utf8');
    await api.execute({ operation: 'send', projectId: f.project.definition.id, sessionId: f.session.id, prompt: 'Change', paths: ['src/main.ts'] });
    while (!compiling) await new Promise(resolve => setTimeout(resolve, 5));
    await api.execute({ operation: 'cancel', projectId: f.project.definition.id, sessionId: f.session.id });
    assert.equal((await wait(api, f.project.definition.id, f.session.id)).status, 'cancelled');
    assert.equal(await readFile(join(f.project.sourceDirectory, 'main.ts'), 'utf8'), original);
  } finally { output.resolve({ files: { 'index.html': 'late' }, logs: [] }); await api.dispose(); await builds.dispose(); await f.cleanup(); }
});
test('explicit AI Git permission queues a commit only after source has successfully applied', async () => {
  const f = await fixture(async (_input, signal) => proposal); let queued = false;
  f.provider.generate = async (_input, signal, access) => {
    await access!.execute('git_commit', { message: 'AI greeting' }, signal); queued = true; return proposal;
  };
  const builds = new CandidateBuildApi(f.workspace, input => compile(input), async () => {});
  const api = new DevelopmentApi(f.workspace, f.provider, 5000, new AutomaticEdits(f.workspace, f.profile, builds, () => {}));
  try {
    await api.execute({ operation: 'send', projectId: f.project.definition.id, sessionId: f.session.id, prompt: 'Change', paths: ['src/main.ts'], commit: true });
    const turn = await wait(api, f.project.definition.id, f.session.id); assert.equal(turn.status, 'completed', turn.error ?? '');
    assert.ok(queued && turn.commitId); assert.equal((await gitStatus(f.project.rootDirectory)).changed.length, 0);
    assert.equal((await gitHistory(f.project.rootDirectory))[0].message, 'AI greeting');
  } finally { await api.dispose(); await builds.dispose(); await f.cleanup(); }
});
test('external edits during the automatic build cannot be overwritten by a late result', async () => {
  const f = await fixture(async () => proposal); const ready = deferred<void>(); const resume = deferred<void>();
  const builds = new CandidateBuildApi(f.workspace, async input => { ready.resolve(); await resume.promise; return compile(input); }, async () => {});
  const api = new DevelopmentApi(f.workspace, f.provider, 5000, new AutomaticEdits(f.workspace, f.profile, builds, () => {}));
  try {
    await api.execute({ operation: 'send', projectId: f.project.definition.id, sessionId: f.session.id, prompt: 'Change', paths: ['src/main.ts'] });
    await ready.promise; await writeFile(join(f.project.sourceDirectory, 'main.ts'), 'User edit'); resume.resolve();
    assert.equal((await wait(api, f.project.definition.id, f.session.id)).status, 'failed');
    assert.equal(await readFile(join(f.project.sourceDirectory, 'main.ts'), 'utf8'), 'User edit');
  } finally { resume.resolve(); await api.dispose(); await builds.dispose(); await f.cleanup(); }
});

test('a failed completion notification cannot misreport a successfully applied source transaction', async () => {
  const f = await fixture(async () => proposal);
  const builds = new CandidateBuildApi(f.workspace, input => compile(input), async () => {});
  try {
    await f.send(); const turn = (await f.settled()).turns[0];
    const edits = new AutomaticEdits(f.workspace, f.profile, builds, () => {});
    const result = await edits.apply(f.project.definition.id, { sessionId: f.session.id, turnId: turn.id }, new AbortController().signal,
      async () => {}, async event => { if (event.kind === 'apply' && event.status === 'completed') throw new Error('Window closed after commit'); });
    assert.ok(result.buildId); assert.equal(await readFile(join(f.project.sourceDirectory, 'main.ts'), 'utf8'), proposal.files[0].content);
  } finally { await builds.dispose(); await f.cleanup(); }
});
