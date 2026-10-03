import assert from 'node:assert/strict';
export async function verifyVersionSave(page, project, buildId) {
  const projectId = project.definition.id;
  const before = await page.evaluate(async projectId => {
    const status = await window.dreamEdge.git({ operation: 'status', projectId });
    await window.dreamEdge.git({ operation: 'commit', projectId, message: 'Before edit', expectedStateHash: status.stateHash });
    return window.dreamEdge.git({ operation: 'status', projectId });
  }, projectId);
  const original = await page.evaluate(projectId => window.dreamEdge.workspace({ operation: 'readFile', projectId, path: 'main.ts' }), projectId);
  await page.evaluate(({ projectId, buildId }) => window.dreamEdge.git({ operation: 'applyBuild', projectId, buildId }), { projectId, buildId });
  await page.frameLocator('iframe').getByText('Candidate HelloWorld', { exact: true }).waitFor();
  const saved = await page.evaluate(async projectId => {
    const status = await window.dreamEdge.git({ operation: 'status', projectId });
    await window.dreamEdge.git({ operation: 'commit', projectId, message: 'Saved edit', expectedStateHash: status.stateHash });
    return window.dreamEdge.git({ operation: 'status', projectId });
  }, projectId);
  assert.notEqual(saved.head, before.head);
  await page.evaluate(({ projectId, commitId, expectedStateHash }) => window.dreamEdge.git({ operation: 'restore', projectId, commitId, expectedStateHash }),
    { projectId, commitId: before.head, expectedStateHash: saved.stateHash });
  const file = await page.evaluate(projectId => window.dreamEdge.workspace({ operation: 'readFile', projectId, path: 'main.ts' }), projectId);
  assert.equal(file.content, original.content);
  await page.frameLocator('iframe').locator('body').filter({ hasText: original.content.includes('Updated HelloWorld') ? 'Updated HelloWorld' : 'HelloWorld' }).waitFor();
  const restored = await page.evaluate(projectId => window.dreamEdge.git({ operation: 'status', projectId }), projectId);
  assert.equal(restored.head, saved.head); assert.ok(restored.changed.length);
  return { versionId: saved.head };
}
