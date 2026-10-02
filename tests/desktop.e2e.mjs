import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { _electron as electron } from 'playwright';
import electronPath from 'electron';
import { SHELL_ORIGIN, TOOL_CHANNEL } from '../packages/sdk/dist/contracts.js';

const directory = await mkdtemp(join(tmpdir(), 'dreamedge-framework-'));
const sourceDirectory = await mkdtemp(join(tmpdir(), 'dreamedge-source-'));
const errors = [];
let application;
async function launch() {
  const env = { ...process.env, DREAMEDGE_DATA_DIR: directory };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.DREAMEDGE_AI_API_KEY;
  delete env.DREAMEDGE_AI_MODEL;
  delete env.DREAMEDGE_AI_BASE_URL;
  application = await electron.launch({ executablePath: process.env.DREAMEDGE_EXECUTABLE_PATH || electronPath,
    args: process.env.DREAMEDGE_EXECUTABLE_PATH ? [] : [resolve('.')], env });
  const page = await application.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  const content = page.frameLocator('iframe');
  await content.getByText('HelloWorld', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button').count(), 0);
  assert.equal(await content.getByRole('button').count(), 0);
  return { page, content };
}
async function storage(content, payload) {
  return content.locator('body').evaluate((_body, { payload, channel, origin }) => new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID();
    const timer = setTimeout(() => { window.removeEventListener('message', receive); reject(new Error('Framework bridge timed out')); }, 10000);
    function receive(event) {
      if (event.source !== window.parent || event.origin !== origin || event.data?.channel !== channel || event.data.requestId !== requestId) return;
      clearTimeout(timer); window.removeEventListener('message', receive);
      if (event.data.error) reject(new Error(event.data.error)); else resolve(event.data.result);
    }
    window.addEventListener('message', receive);
    window.parent.postMessage({ channel, type: 'request', requestId, request: { kind: 'storage', payload } }, origin);
  }), { payload, channel: TOOL_CHANNEL, origin: SHELL_ORIGIN });
}
try {
  let { page, content } = await launch();
  assert.equal(await application.evaluate(({ app }) => app.getName()), 'DreamEdge');
  assert.equal(await content.locator('body').evaluate(() => typeof window.dreamEdge), 'undefined');
  assert.equal(await content.locator('body').evaluate(() => typeof window.require), 'undefined');
  assert.equal(await content.locator('body').evaluate(() => {
    try { return typeof window.parent.dreamEdge; } catch { return 'blocked'; }
  }), 'blocked');
  const project = await page.evaluate(directory => window.dreamEdge.workspace({ operation: 'create', directory, name: 'HelloWorld fixture' }), join(sourceDirectory, 'project'));
  const connection = await page.evaluate(() => window.dreamEdge.development({ operation: 'connection' }));
  assert.equal(connection.available, false);
  const modelSession = await page.evaluate(projectId => window.dreamEdge.development({ operation: 'create', projectId, title: 'Model fixture' }), project.definition.id);
  await page.evaluate(({ projectId, sessionId }) => window.dreamEdge.development({ operation: 'send', projectId, sessionId, prompt: 'Update greeting', paths: ['main.ts'] }), { projectId: project.definition.id, sessionId: modelSession.id });
  await page.waitForFunction(async ({ projectId, sessionId }) => {
    const session = await window.dreamEdge.development({ operation: 'get', projectId, sessionId });
    return session.turns[0].status === 'failed';
  }, { projectId: project.definition.id, sessionId: modelSession.id });
  const original = await page.evaluate(projectId => window.dreamEdge.workspace({ operation: 'readFile', projectId, path: 'main.ts' }), project.definition.id);
  await page.evaluate(({ projectId, hash }) => window.dreamEdge.workspace({ operation: 'writeFile', projectId, path: 'main.ts', content: "document.body.textContent = 'Updated HelloWorld';", expectedHash: hash }), { projectId: project.definition.id, hash: original.hash });
  await page.evaluate(projectId => window.dreamEdge.workspace({ operation: 'save', projectId, name: 'Saved framework fixture' }), project.definition.id);
  await assert.rejects(page.evaluate(projectId => window.dreamEdge.workspace({ operation: 'readFile', projectId, path: '../outside' }), project.definition.id));
  await assert.rejects(page.evaluate(directory => window.dreamEdge.workspace({ operation: 'create', directory, name: 'Forbidden' }), resolve('forbidden-project')));
  await storage(content, { operation: 'put', collection: 'framework-test', id: 'record', value: { message: 'persisted' } });
  await assert.rejects(storage(content, { operation: 'put', collection: '../outside', id: 'record', value: {} }));
  assert.ok(await page.evaluate(async () => { try { await window.dreamEdge.storage('other-app', { operation: 'list', collection: 'framework-test' }); return false; } catch { return true; } }));
  assert.ok(await page.evaluate(async () => { try { await window.dreamEdge.service('hello-world', 'unknown', 'read', null); return false; } catch { return true; } }));
  await page.reload();
  await content.getByText('HelloWorld', { exact: true }).waitFor();
  assert.deepEqual(await storage(content, { operation: 'list', collection: 'framework-test' }), [{ id: 'record', value: { message: 'persisted' } }]);
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k');
  assert.equal(await page.getByRole('complementary').count(), 0);
  await mkdir('artifacts', { recursive: true });
  await page.screenshot({ path: 'artifacts/hello-world-desktop.png' });
  await application.close();
  ({ page, content } = await launch());
  const restored = await page.evaluate(() => window.dreamEdge.workspace({ operation: 'current' }));
  assert.equal(restored.project.definition.id, project.definition.id);
  assert.equal(restored.project.definition.name, 'Saved framework fixture');
  const recoveredSession = await page.evaluate(({ projectId, sessionId }) => window.dreamEdge.development({ operation: 'get', projectId, sessionId }), { projectId: project.definition.id, sessionId: modelSession.id });
  assert.equal(recoveredSession.turns[0].status, 'failed');
  assert.deepEqual(recoveredSession.turns[0].changes, []);
  const restoredFile = await page.evaluate(projectId => window.dreamEdge.workspace({ operation: 'readFile', projectId, path: 'main.ts' }), project.definition.id);
  assert.ok(restoredFile.content.includes('Updated HelloWorld'));
  await page.evaluate(() => window.dreamEdge.workspace({ operation: 'close' }));
  assert.deepEqual(await storage(content, { operation: 'list', collection: 'framework-test' }), [{ id: 'record', value: { message: 'persisted' } }]);
  await storage(content, { operation: 'remove', collection: 'framework-test', id: 'record' });
  await application.close();
  ({ page, content } = await launch());
  assert.equal((await page.evaluate(() => window.dreamEdge.workspace({ operation: 'current' }))).project, null);
  assert.deepEqual(await storage(content, { operation: 'list', collection: 'framework-test' }), []);
  assert.deepEqual(errors, []);
  console.log('PASS: HelloWorld shell, host-only workspace and model sessions, source boundaries and restart recovery.');
} finally {
  if (application) {
    const closed = await Promise.race([application.close().then(() => true).catch(() => true), new Promise(resolve => setTimeout(() => resolve(false), 5000))]);
    if (!closed) application.process().kill('SIGKILL');
  }
  await rm(directory, { recursive: true, force: true });
  await rm(sourceDirectory, { recursive: true, force: true });
}
