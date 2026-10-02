import assert from 'node:assert/strict';

async function settled(page, method, request) {
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    const result = await page.evaluate(({ method, request }) => window.dreamEdge[method](request), { method, request });
    if (result.status !== 'running') return result;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Dependency operation timed out');
}

export async function buildCandidate(page, request) {
  const started = await page.evaluate(request => window.dreamEdge.build(request), { operation: 'start', ...request });
  const query = { operation: 'get', projectId: request.projectId, buildId: started.id };
  const result = await settled(page, 'build', query);
  assert.equal(result.status, 'succeeded', JSON.stringify(result.logs));
  return result;
}

export async function confirmCandidate(page, projectId, buildId) {
  const started = await page.evaluate(request => window.dreamEdge.versions(request), {
    operation: 'confirm', projectId, buildId, label: '依赖接口验收',
  });
  const query = { operation: 'getOperation', projectId, operationId: started.id };
  const result = await settled(page, 'versions', query);
  assert.equal(result.status, 'completed', result.error ?? '');
  return result;
}
