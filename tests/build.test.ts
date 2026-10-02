import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, writeFile, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { CandidateBuild, WorkspaceProject } from '../shared/contracts';
import { CandidateBuildApi } from '../desktop/build/api';
import { compile } from '../desktop/build/compiler';
import { servePreview } from '../desktop/build/preview-assets';
import type { BuildOutput } from '../desktop/build/types';
import { fixture, deferred, proposal } from './development-fixture';

async function settled(api: CandidateBuildApi, projectId: string, buildId: string): Promise<CandidateBuild> {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    const record = await api.execute({ operation: 'get', projectId, buildId }) as CandidateBuild;
    if (record.status !== 'running') return record;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Build did not settle');
}
test('model candidate builds an independent snapshot and preview serves only checksummed outputs', async () => {
  const f = await fixture(async () => proposal);
  let previewed = false;
  const api = new CandidateBuildApi(f.workspace, input => compile(input), async () => { previewed = true; });
  try {
    await f.send(); const session = await f.settled();
    const candidate = { sessionId: session.id, turnId: session.turns[0].id };
    const started = await api.execute({ operation: 'start', projectId: f.project.definition.id, candidate }) as CandidateBuild;
    const record = await settled(api, f.project.definition.id, started.id);
    assert.equal(record.status, 'succeeded'); assert.ok(record.previewUrl);
    assert.ok((await readFile(join(f.project.sourceDirectory, 'main.ts'), 'utf8')).includes('HelloWorld'));
    assert.equal(await readFile(join(f.project.buildDirectory, record.id, 'source/main.ts'), 'utf8'), proposal.files[0].content);
    const response = await servePreview(f.project, record, record.previewUrl!);
    assert.equal(response.status, 200); assert.match(await response.text(), /module0.js/);
    assert.ok(response.headers.get('Content-Security-Policy')!.includes("connect-src 'none'"));
    const base = record.previewUrl!.replace(/index.html$/, '');
    assert.equal((await servePreview(f.project, record, base + 'record.json')).status, 404);
    assert.equal((await servePreview(f.project, record, base + '%2e%2e%2fsource%2fmain.ts')).status, 404);
    assert.equal((await servePreview(f.project, record, record.previewUrl!.replace('dreamedge-preview:', 'file:'))).status, 404);
    await api.execute({ operation: 'openPreview', projectId: f.project.definition.id, buildId: record.id });
    assert.equal(previewed, true);
    await writeFile(join(f.project.buildDirectory, record.id, 'output/index.html'), 'tampered');
    assert.equal((await servePreview(f.project, record, record.previewUrl!)).status, 404);
    await assert.rejects(api.execute({ operation: 'openPreview', projectId: f.project.definition.id, buildId: record.id }), /产物已变化/);
  } finally { await api.dispose(); await f.cleanup(); }
});
test('stale candidate and source changes during compilation cannot yield a preview', async () => {
  const f = await fixture(async () => proposal); const answer = deferred<BuildOutput>();
  const api = new CandidateBuildApi(f.workspace, () => answer.promise, async () => {});
  try {
    await f.send(); const session = await f.settled();
    const candidate = { sessionId: session.id, turnId: session.turns[0].id };
    await writeFile(join(f.project.sourceDirectory, 'main.ts'), 'external edit');
    await assert.rejects(api.execute({ operation: 'start', projectId: f.project.definition.id, candidate }), /过期|不匹配/);
    const started = await api.execute({ operation: 'start', projectId: f.project.definition.id }) as CandidateBuild;
    await writeFile(join(f.project.sourceDirectory, 'main.ts'), 'newer external edit');
    answer.resolve({ files: { 'index.html': 'candidate' }, logs: [] });
    const record = await settled(api, f.project.definition.id, started.id);
    assert.equal(record.status, 'failed'); assert.equal(record.previewUrl, null);
    await assert.rejects(api.execute({ operation: 'openPreview', projectId: f.project.definition.id, buildId: record.id }), /成功/);
    assert.equal(await readFile(join(f.project.sourceDirectory, 'main.ts'), 'utf8'), 'newer external edit');
  } finally { await api.dispose(); await f.cleanup(); }
});
test('cancel, timeout and interrupted restoration preserve source and terminate build state', async () => {
  const f = await fixture(async () => proposal);
  const api = new CandidateBuildApi(f.workspace, () => new Promise(() => {}), async () => {}, 1000);
  try {
    const started = await api.execute({ operation: 'start', projectId: f.project.definition.id }) as CandidateBuild;
    const cancelled = await api.execute({ operation: 'cancel', projectId: f.project.definition.id, buildId: started.id }) as CandidateBuild;
    assert.equal(cancelled.status, 'cancelled');
    const timeout = new CandidateBuildApi(f.workspace, () => new Promise(() => {}), async () => {}, 20);
    const pending = await timeout.execute({ operation: 'start', projectId: f.project.definition.id }) as CandidateBuild;
    assert.equal((await settled(timeout, f.project.definition.id, pending.id)).status, 'failed');
    await timeout.dispose();
    await writeFile(join(f.project.buildDirectory, started.id, 'record.json'), JSON.stringify({ ...started, status: 'running' }));
    const restored = new CandidateBuildApi(f.workspace, input => compile(input), async () => {});
    assert.equal((await restored.execute({ operation: 'get', projectId: f.project.definition.id, buildId: started.id }) as CandidateBuild).status, 'interrupted');
    await restored.dispose();
    assert.ok((await readFile(join(f.project.sourceDirectory, 'main.ts'), 'utf8')).includes('HelloWorld'));
  } finally { await api.dispose(); await f.cleanup(); }
});
test('project switches reject old build results and linked source is never copied into a candidate', async () => {
  const f = await fixture(async () => proposal); const answer = deferred<BuildOutput>();
  const api = new CandidateBuildApi(f.workspace, () => answer.promise, async () => {});
  try {
    await symlink(f.framework, join(f.project.sourceDirectory, 'linked'));
    await assert.rejects(api.execute({ operation: 'start', projectId: f.project.definition.id }), /链接/);
    await rm(join(f.project.sourceDirectory, 'linked'));
    const started = await api.execute({ operation: 'start', projectId: f.project.definition.id }) as CandidateBuild;
    const other = await f.workspace.execute({ operation: 'create', directory: join(f.root, 'second'), name: 'Second' }) as WorkspaceProject;
    await assert.rejects(api.execute({ operation: 'get', projectId: f.project.definition.id, buildId: started.id }), /当前工程/);
    await assert.rejects(api.execute({ operation: 'get', projectId: other.definition.id, buildId: started.id }));
    answer.resolve({ files: { 'index.html': 'candidate' }, logs: [] });
    const path = join(f.project.buildDirectory, started.id, 'record.json');
    const deadline = Date.now() + 2000;
    while (JSON.parse(await readFile(path, 'utf8')).status === 'running' && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    await f.workspace.execute({ operation: 'open', directory: f.project.rootDirectory });
    assert.equal((await settled(api, f.project.definition.id, started.id)).status, 'failed');
    assert.ok((await readFile(join(other.sourceDirectory, 'main.ts'), 'utf8')).includes('HelloWorld'));
  } finally { await api.dispose(); await f.cleanup(); }
});
