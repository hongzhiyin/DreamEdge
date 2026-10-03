import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { DevelopmentSession } from '../shared/contracts';
import { DevelopmentApi } from '../desktop/development/api';
import { AutomaticEdits } from '../desktop/development/apply';
import { CandidateBuildApi } from '../desktop/build/api';
import { compile } from '../desktop/build/compiler';
import { ProjectAccess } from '../desktop/development/project-access';
import { collectContext, validateProposal } from '../desktop/development/context';
import { currentVersionState } from '../desktop/changes/current';
import { applyState } from '../desktop/changes/apply';
import { hash } from '../desktop/workspace/paths';
import { modelInstructions } from '../desktop/development/model';
import { fixture, proposal } from './development-fixture';

async function until(api: DevelopmentApi, f: Awaited<ReturnType<typeof fixture>>) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    const session = await api.execute({ operation: 'get', projectId: f.project.definition.id, sessionId: f.session.id }) as DevelopmentSession;
    if (session.turns[0]?.status !== 'running') return session.turns[0];
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Root edit did not finish');
}
test('AI explores the project root and atomically saves .gitignore/README plus compiled src edits', async () => {
  const f = await fixture(async () => proposal);
  const builds = new CandidateBuildApi(f.workspace, async input => {
    assert.ok(Object.hasOwn(input.files, 'main.ts')); assert.ok(!Object.hasOwn(input.files, '.gitignore')); assert.ok(!Object.hasOwn(input.files, 'README.md'));
    return compile(input);
  }, async () => {});
  const api = new DevelopmentApi(f.workspace, f.provider, 12000, new AutomaticEdits(f.workspace, f.profile, builds, () => {}));
  try {
    await writeFile(join(f.project.rootDirectory, 'README.md'), '# Original');
    await writeFile(join(f.project.rootDirectory, '.dreamedge/model.json'), 'fixture-private-key');
    f.provider.generate = async (_input, signal, access) => {
      const list = await access!.execute('list_files', { directory: '', offset: 0 }, signal) as { files: string[] };
      assert.ok(list.files.includes('.gitignore')); assert.ok(list.files.includes('README.md')); assert.ok(list.files.includes('src/main.ts'));
      assert.ok(!list.files.some(path => path.startsWith('.dreamedge/') || path.startsWith('.git/')));
      const ignore = await access!.execute('read_file', { path: '.gitignore' }, signal) as { content: string };
      await access!.execute('read_file', { path: 'README.md' }, signal); await access!.execute('read_file', { path: 'src/main.ts' }, signal);
      return { summary: 'Updated root files and renderer', files: [{ path: '.gitignore', content: ignore.content + '**/.DS_Store\n' },
        { path: 'README.md', content: '# Updated' }, { path: 'src/main.ts', content: "document.getElementById('root')!.textContent='Root scope';" }] };
    };
    await api.execute({ operation: 'send', projectId: f.project.definition.id, sessionId: f.session.id, prompt: 'Fix root .gitignore and greeting' });
    const turn = await until(api, f); assert.equal(turn.status, 'completed', turn.error ?? ''); assert.equal(turn.applied, true);
    assert.match(await readFile(join(f.project.rootDirectory, '.gitignore'), 'utf8'), /\*\*\/\.DS_Store/);
    assert.equal(await readFile(join(f.project.rootDirectory, 'README.md'), 'utf8'), '# Updated');
    assert.match(await readFile(join(f.project.sourceDirectory, 'main.ts'), 'utf8'), /Root scope/);
    assert.equal(await readFile(join(f.project.rootDirectory, '.dreamedge/model.json'), 'utf8'), 'fixture-private-key');
    assert.ok(modelInstructions.includes('BUSINESS PROJECT ROOT')); assert.ok(!modelInstructions.includes('never paths outside src'));
  } finally { await api.dispose(); await builds.dispose(); await f.cleanup(); }
});
test('root contexts protect private/ignored paths and existing unread files', async () => {
  const f = await fixture(async () => proposal);
  try {
    await writeFile(join(f.project.rootDirectory, 'README.md'), 'Do not overwrite');
    await mkdir(join(f.project.rootDirectory, 'ignored')); await writeFile(join(f.project.rootDirectory, 'ignored/data.txt'), 'Private');
    const ignore = await readFile(join(f.project.rootDirectory, '.gitignore'), 'utf8'); await writeFile(join(f.project.rootDirectory, '.gitignore'), ignore + '/ignored/\n');
    const context = await collectContext(f.project, []); const tools = new ProjectAccess(f.workspace, f.project.definition.id, context);
    for (const path of ['../DreamEdge/file.ts', '.git/config', '.dreamedge/model.json', '.env', 'ignored/data.txt', 'node_modules/code.js']) {
      await assert.rejects(tools.execute('read_file', { path }, new AbortController().signal));
      await assert.rejects(validateProposal(f.project, context, { summary: 'Bad', files: [{ path, content: 'Bad' }] }));
    }
    await assert.rejects(validateProposal(f.project, context, { summary: 'Unread', files: [{ path: 'README.md', content: 'Bad' }] }), /未提供上下文/);
  } finally { await f.cleanup(); }
});
test('root edits roll back with source on transaction failure, without overwriting a newer external root edit', async () => {
  const f = await fixture(async () => proposal);
  try {
    await writeFile(join(f.project.rootDirectory, 'README.md'), 'Before'); const current = await currentVersionState(f.project);
    const change = { path: 'README.md', content: 'After', expectedHash: hash('Before') };
    await assert.rejects(applyState(f.project, f.profile, { ...current.files, 'main.ts': 'After source' }, current.definition, current.stateHash,
      new AbortController().signal, async phase => { if (phase === 'metadata-installed') throw new Error('Injected failure'); }, [change]));
    assert.equal(await readFile(join(f.project.rootDirectory, 'README.md'), 'utf8'), 'Before');
    assert.equal(await readFile(join(f.project.sourceDirectory, 'main.ts'), 'utf8'), current.files['main.ts']);
    await writeFile(join(f.project.rootDirectory, 'README.md'), 'User change');
    await assert.rejects(applyState(f.project, f.profile, current.files, current.definition, current.stateHash, new AbortController().signal, undefined, [change]), /变化/);
    assert.equal(await readFile(join(f.project.rootDirectory, 'README.md'), 'utf8'), 'User change');
  } finally { await f.cleanup(); }
});
