import assert from 'node:assert/strict';

async function waitOperation(page, projectId, operation) {
  const deadline = Date.now() + 30000;
  let result = operation;
  while (result.status === 'running' && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 20));
    result = await page.evaluate(({ projectId, operationId }) => window.dreamEdge.versions({ operation: 'getOperation', projectId, operationId }),
      { projectId, operationId: operation.id });
  }
  assert.equal(result.status, 'completed', result.error);
  return result;
}
export async function verifyVersionSave(page, project, buildId) {
  const projectId = project.definition.id;
  const original = await page.evaluate(projectId => window.dreamEdge.workspace({ operation: 'readFile', projectId, path: 'main.ts' }), projectId);
  const started = await page.evaluate(({ projectId, buildId }) => window.dreamEdge.versions({ operation: 'confirm', projectId, buildId, label: 'Confirmed candidate' }), { projectId, buildId });
  const saved = await waitOperation(page, projectId, started);
  assert.ok(saved.versionId); assert.ok(saved.checkpointId);
  const changed = await page.evaluate(projectId => window.dreamEdge.workspace({ operation: 'readFile', projectId, path: 'main.ts' }), projectId);
  assert.ok(changed.content.includes('Candidate HelloWorld'));
  const current = await page.evaluate(() => window.dreamEdge.workspace({ operation: 'current' }));
  assert.equal(current.project.definition.version, '0.1.1');
  const status = await page.evaluate(projectId => window.dreamEdge.versions({ operation: 'status', projectId }), projectId);
  assert.equal(status.versions.length, 2); assert.equal(status.head, saved.versionId);
  const pending = await page.evaluate(({ projectId, versionId, expectedStateHash }) => window.dreamEdge.versions({ operation: 'restore', projectId,
    versionId, expectedStateHash, label: 'Restored source' }), { projectId, versionId: saved.checkpointId, expectedStateHash: status.stateHash });
  const restored = await waitOperation(page, projectId, pending);
  const file = await page.evaluate(projectId => window.dreamEdge.workspace({ operation: 'readFile', projectId, path: 'main.ts' }), projectId);
  assert.equal(file.content, original.content);
  await assert.rejects(page.evaluate(({ projectId, buildId }) => window.dreamEdge.versions({ operation: 'confirm', projectId, buildId, label: 'Stale replay' }), { projectId, buildId }));
  return restored;
}
