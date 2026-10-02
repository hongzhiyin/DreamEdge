import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export async function verifyBuildPreview(application, page, project) {
  const projectId = project.definition.id;
  const original = await page.evaluate(projectId => window.dreamEdge.workspace({ operation: 'readFile', projectId, path: 'main.ts' }), projectId);
  // Seed a completed model response in the temporary profile; no real API credentials or calls.
  const session = await page.evaluate(projectId => window.dreamEdge.development({ operation: 'create', projectId, title: 'Candidate fixture' }), projectId);
  const id = randomUUID(); const now = new Date().toISOString();
  const turn = { id, prompt: 'Change greeting', startedAt: now, finishedAt: now, status: 'completed', summary: 'Candidate greeting', error: null,
    context: [{ path: 'main.ts', hash: original.hash }], changes: [{ path: 'main.ts', expectedHash: original.hash,
      content: "document.body.textContent = 'Candidate HelloWorld';" }] };
  const sessionRoot = join(project.sessionsDirectory, session.id);
  await mkdir(join(sessionRoot, id));
  await writeFile(join(sessionRoot, id, 'turn.json'), JSON.stringify(turn));
  const current = (await page.evaluate(() => window.dreamEdge.workspace({ operation: 'current' }))).project.definition;
  const { dependencyLock: _lock, ...definition } = current;
  await writeFile(join(sessionRoot, id, 'request-context.json'), JSON.stringify({ definition, files: [{ path: 'main.ts', content: original.content, hash: original.hash }] }));
  const metadata = JSON.parse(await readFile(join(sessionRoot, 'session.json'), 'utf8'));
  await writeFile(join(sessionRoot, 'session.json'), JSON.stringify({ ...metadata, turnIds: [id] }));
  const record = await page.evaluate(({ projectId, sessionId, turnId }) => window.dreamEdge.build({ operation: 'start', projectId,
    candidate: { sessionId, turnId } }), { projectId, sessionId: session.id, turnId: id });
  const deadline = Date.now() + 30000;
  let completed = record;
  while (completed.status === 'running' && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 20));
    completed = await page.evaluate(({ projectId, buildId }) => window.dreamEdge.build({ operation: 'get', projectId, buildId }), { projectId, buildId: record.id });
  }
  assert.equal(completed.status, 'succeeded', JSON.stringify(completed.logs));
  const opened = application.waitForEvent('window');
  await page.evaluate(({ projectId, buildId }) => window.dreamEdge.build({ operation: 'openPreview', projectId, buildId }), { projectId, buildId: record.id });
  const preview = await opened;
  await preview.getByText('Candidate HelloWorld', { exact: true }).waitFor();
  assert.deepEqual(await preview.evaluate(() => ({ bridge: typeof window.dreamEdge, node: typeof window.require, process: typeof window.process })),
    { bridge: 'undefined', node: 'undefined', process: 'undefined' });
  assert.equal(await preview.evaluate(() => window.open('https://example.com')), null);
  for (const url of ['file:///etc/passwd', 'dreamedge://shell/index.html', 'https://example.com']) {
    assert.equal(await preview.evaluate(async url => { try { await fetch(url); return true; } catch { return false; } }, url), false);
  }
  await preview.evaluate(() => { localStorage.setItem('preview-fixture', 'isolated'); location.href = 'dreamedge://shell/index.html'; });
  assert.equal(preview.url(), completed.previewUrl);
  assert.equal(await page.evaluate(() => localStorage.getItem('preview-fixture')), null);
  assert.equal(await readFile(join(project.sourceDirectory, 'main.ts'), 'utf8'), original.content);
  await preview.close();
  return completed.id;
}
