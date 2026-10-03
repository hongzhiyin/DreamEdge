import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DevelopmentSession } from '../shared/contracts';
import { gitIntent } from '../desktop/development/git-intent';
import { DevelopmentApi } from '../desktop/development/api';
import { AutomaticEdits } from '../desktop/development/apply';
import { CandidateBuildApi } from '../desktop/build/api';
import { compile } from '../desktop/build/compiler';
import { ProjectAccess } from '../desktop/development/project-access';
import { collectContext } from '../desktop/development/context';
import { git } from '../desktop/git/command';
import { gitHistory } from '../desktop/git/history';
import { fixture, proposal, deferred } from './development-fixture';

async function setup() {
  const f = await fixture(async () => proposal); const builds = new CandidateBuildApi(f.workspace, compile, async () => {});
  const api = new DevelopmentApi(f.workspace, f.provider, 12000, new AutomaticEdits(f.workspace, f.profile, builds, () => {}));
  const send = (prompt: string) => api.execute({ operation: 'send', projectId: f.project.definition.id, sessionId: f.session.id, prompt });
  const settled = async () => {
    const end = Date.now() + 12000;
    while (Date.now() < end) {
      const value = await api.execute({ operation: 'get', projectId: f.project.definition.id, sessionId: f.session.id }) as DevelopmentSession;
      if (value.turns.at(-1)?.status !== 'running') return value.turns.at(-1)!;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('Git turn did not settle');
  };
  return { ...f, api, builds, send, settled, close: async () => { await api.dispose(); await builds.dispose(); await f.cleanup(); } };
}
test('only current explicit Git requests grant writes, not questions, negations or history nouns', () => {
  assert.equal(gitIntent('不要提交当前修改', true).commit, false);
  for (const prompt of ['提交当前修改', '请把这些修改提交到 Git', '修改页面，然后提交', 'Could you commit these changes?']) assert.equal(gitIntent(prompt).commit, true, prompt);
  for (const prompt of ['查看提交历史', '不要提交当前修改', '解释如何提交', '提交会影响远程吗？', 'commit history', "don't commit"]) assert.equal(gitIntent(prompt).commit, false, prompt);
  for (const prompt of ['恢复上一次提交中的页面', '请把页面恢复到上一版', 'restore previous commit']) assert.equal(gitIntent(prompt).restore, true, prompt);
  for (const prompt of ['查看恢复记录', '不要恢复', '恢复是什么意思', '恢复会丢文件吗？']) assert.equal(gitIntent(prompt).restore, false, prompt);
});
test('read-only Git tools inspect root changes/history/diffs without leaking private paths or granting mutations', async () => {
  const f = await fixture(async () => proposal);
  try {
    await writeFile(join(f.project.rootDirectory, 'README.md'), 'A root change');
    await writeFile(join(f.project.rootDirectory, '.dreamedge/model.json'), 'keep-key');
    const access = new ProjectAccess(f.workspace, f.project.definition.id, await collectContext(f.project, [])); const signal = new AbortController().signal;
    const status = await access.execute('git_status', {}, signal) as { head: string; changed: string[] };
    assert.ok(status.changed.includes('README.md')); assert.ok(!JSON.stringify(status).includes(f.root));
    const diff = await access.execute('git_diff', { commitId: null, paths: ['README.md'] }, signal); assert.match(JSON.stringify(diff), /A root change/);
    const log = await access.execute('git_log', { limit: 10 }, signal) as { commits: unknown[] }; assert.equal(log.commits.length, 1);
    await assert.rejects(access.execute('git_commit', { message: 'Unauthorized' }, signal), /没有要求/);
    await assert.rejects(access.execute('git_restore', { commitId: status.head, paths: [] }, signal), /没有明确/);
    await assert.rejects(access.execute('git_diff', { commitId: null, paths: ['.dreamedge/model.json'] }, signal), /私有/);
    assert.equal((await git(f.project.rootDirectory, ['rev-parse', 'HEAD'])).trim(), status.head);
  } finally { await f.cleanup(); }
});
test('natural-language commit covers the whole business repository and later read-only turns never auto-commit', async () => {
  const f = await setup();
  try {
    await writeFile(join(f.project.rootDirectory, 'README.md'), 'Root document');
    f.provider.generate = async (input, signal, access) => {
      assert.equal(input.commit, true); await access!.execute('git_status', {}, signal);
      await access!.execute('git_commit', { message: 'AI root commit' }, signal); return { summary: 'Committed', files: [] };
    };
    await f.send('提交当前修改'); const saved = await f.settled(); assert.equal(saved.status, 'completed', saved.error ?? ''); assert.ok(saved.commitId);
    assert.equal(await git(f.project.rootDirectory, ['show', 'HEAD:README.md']), 'Root document');
    await writeFile(join(f.project.rootDirectory, 'README.md'), 'Next change');
    f.provider.generate = async input => { assert.equal(input.commit, false); assert.equal(input.restore, false); return { summary: 'Read only', files: [] }; };
    await f.send('查看历史，不要提交，也不要恢复'); await f.settled();
    assert.equal((await git(f.project.rootDirectory, ['rev-parse', 'HEAD'])).trim(), saved.commitId);
  } finally { await f.close(); }
});
test('AI restores selected text files after compiling, checkpoints dirty work, retains HEAD history and preserves keys/data', async () => {
  const f = await setup();
  try {
    const baseline = (await gitHistory(f.project.rootDirectory))[0].id;
    await writeFile(join(f.project.sourceDirectory, 'main.ts'), "document.getElementById('root')!.textContent='Before restore';");
    await writeFile(join(f.project.rootDirectory, 'README.md'), 'User document');
    await writeFile(join(f.project.rootDirectory, '.dreamedge/model.json'), 'Keep model key'); await writeFile(join(f.project.dataDirectory, 'value'), 'Keep data');
    f.provider.generate = async (input, signal, tools) => {
      assert.equal(input.restore, true); await tools!.execute('git_log', { limit: 10 }, signal);
      await tools!.execute('git_restore', { commitId: baseline, paths: ['src/main.ts'] }, signal);
      return { summary: 'Restored greeting', files: [] };
    };
    await f.send('恢复上一次提交中的页面'); const restored = await f.settled(); assert.equal(restored.status, 'completed', restored.error ?? '');
    assert.ok(restored.checkpointCommitId && restored.applied); assert.equal(restored.gitRestoreCommitId, baseline);
    assert.equal((await git(f.project.rootDirectory, ['rev-parse', 'HEAD'])).trim(), restored.checkpointCommitId);
    assert.match(await git(f.project.rootDirectory, ['show', `${restored.checkpointCommitId}:src/main.ts`]), /Before restore/);
    assert.match(await readFile(join(f.project.sourceDirectory, 'main.ts'), 'utf8'), /HelloWorld/);
    assert.equal(await readFile(join(f.project.rootDirectory, 'README.md'), 'utf8'), 'User document');
    assert.equal(await readFile(join(f.project.rootDirectory, '.dreamedge/model.json'), 'utf8'), 'Keep model key');
    assert.equal(await readFile(join(f.project.dataDirectory, 'value'), 'utf8'), 'Keep data');
    assert.ok(restored.events?.some(event => event.id === 'git-checkpoint'));
  } finally { await f.close(); }
});
test('external edits invalidate queued Git writes rather than committing unseen new contents', async () => {
  const f = await setup(); const ready = deferred<void>(); const resume = deferred<void>();
  try {
    await writeFile(join(f.project.rootDirectory, 'README.md'), 'Reviewed'); const before = (await gitHistory(f.project.rootDirectory))[0].id;
    f.provider.generate = async (_input, signal, access) => { await access!.execute('git_status', {}, signal); await access!.execute('git_commit', { message: 'Queued' }, signal); ready.resolve(); await resume.promise; return { summary: 'Commit', files: [] }; };
    await f.send('提交当前修改'); await ready.promise; await writeFile(join(f.project.rootDirectory, 'README.md'), 'External new edit'); resume.resolve();
    const turn = await f.settled(); assert.equal(turn.status, 'failed'); assert.match(turn.error!, /状态已变化/);
    assert.equal((await git(f.project.rootDirectory, ['rev-parse', 'HEAD'])).trim(), before);
    assert.equal(await readFile(join(f.project.rootDirectory, 'README.md'), 'utf8'), 'External new edit');
  } finally { resume.resolve(); await f.close(); }
});

test('a broken historical renderer never writes files or creates a checkpoint', async () => {
  const f = await setup();
  try {
    await writeFile(join(f.project.sourceDirectory, 'main.ts'), 'const broken: = ;'); await git(f.project.rootDirectory, ['add', '--', 'src']); await git(f.project.rootDirectory, ['commit', '-m', 'Broken external commit']);
    const target = (await gitHistory(f.project.rootDirectory))[0].id;
    const working = "document.getElementById('root')!.textContent='Keep valid work';"; await writeFile(join(f.project.sourceDirectory, 'main.ts'), working);
    f.provider.generate = async (_input, signal, tools) => { await tools!.execute('git_restore', { commitId: target, paths: ['src/main.ts'] }, signal); return { summary: 'Restore', files: [] }; };
    await f.send('恢复上一次提交中的页面'); const turn = await f.settled(); assert.equal(turn.status, 'failed'); assert.equal(turn.checkpointCommitId, undefined);
    assert.equal((await git(f.project.rootDirectory, ['rev-parse', 'HEAD'])).trim(), target); assert.equal(await readFile(join(f.project.sourceDirectory, 'main.ts'), 'utf8'), working);
  } finally { await f.close(); }
});
test('cancellation drops queued Git writes and commit guards refuse tracked credential changes', async () => {
  const f = await setup(); const queued = deferred<void>();
  try {
    const head = (await gitHistory(f.project.rootDirectory))[0].id; await writeFile(join(f.project.rootDirectory, 'README.md'), 'Uncommitted');
    f.provider.generate = async (_input, signal, access) => { await access!.execute('git_commit', { message: 'Cancelled' }, signal); queued.resolve(); return new Promise(() => {}); };
    await f.send('提交当前修改'); await queued.promise; await f.api.execute({ operation: 'cancel', projectId: f.project.definition.id, sessionId: f.session.id });
    assert.equal((await git(f.project.rootDirectory, ['rev-parse', 'HEAD'])).trim(), head);
    await writeFile(join(f.project.rootDirectory, '.env'), 'SECRET=keep'); await git(f.project.rootDirectory, ['add', '-f', '--', '.env']);
    f.provider.generate = async () => ({ summary: 'Commit', files: [] }); await f.send('提交当前修改');
    const turn = await f.settled(); assert.equal(turn.status, 'failed'); assert.match(turn.error!, /凭据/); assert.equal((await git(f.project.rootDirectory, ['rev-parse', 'HEAD'])).trim(), head);
  } finally { await f.close(); }
});
