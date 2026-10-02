import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { _electron as electron } from 'playwright';
import electronPath from 'electron';
import { SHELL_ORIGIN, TOOL_CHANNEL } from '../packages/sdk/dist/contracts.js';

const directory = await mkdtemp(join(tmpdir(), 'dreamedge-framework-'));
const errors = [];
let application;
async function launch() {
  const env = { ...process.env, DREAMEDGE_DATA_DIR: directory };
  delete env.ELECTRON_RUN_AS_NODE;
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
  assert.deepEqual(await storage(content, { operation: 'list', collection: 'framework-test' }), [{ id: 'record', value: { message: 'persisted' } }]);
  await storage(content, { operation: 'remove', collection: 'framework-test', id: 'record' });
  await application.close();
  ({ page, content } = await launch());
  assert.deepEqual(await storage(content, { operation: 'list', collection: 'framework-test' }), []);
  assert.deepEqual(errors, []);
  console.log('PASS: minimal framework shell, isolated bridge, capability checks, reload and durable storage across restart.');
} finally {
  if (application) {
    const closed = await Promise.race([application.close().then(() => true).catch(() => true), new Promise(resolve => setTimeout(() => resolve(false), 5000))]);
    if (!closed) application.process().kill('SIGKILL');
  }
  await rm(directory, { recursive: true, force: true });
}
