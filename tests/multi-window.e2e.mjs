import assert from 'node:assert/strict';
import { mkdtemp, rm, rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { _electron as electron } from 'playwright';
import electronPath from 'electron';
import { verifyBuildPreview } from './build-preview.e2e.mjs';
import { verifyVersionSave } from './version-save.e2e.mjs';

const profile = await mkdtemp(join(tmpdir(), 'dreamedge-window-profile-'));
const source = await mkdtemp(join(tmpdir(), 'dreamedge-window-source-'));
let application;
async function launch() {
  const env = { ...process.env, DREAMEDGE_DATA_DIR: profile };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'DREAMEDGE_AI_API_KEY', 'DREAMEDGE_AI_MODEL', 'DREAMEDGE_AI_BASE_URL']) delete env[key];
  application = await electron.launch({ executablePath: process.env.DREAMEDGE_EXECUTABLE_PATH || electronPath,
    args: process.env.DREAMEDGE_EXECUTABLE_PATH ? [] : [resolve('.')], env });
  const page = await application.firstWindow();
  await hello(page); return page;
}
async function hello(page) { await page.frameLocator('iframe').getByText('HelloWorld', { exact: true }).waitFor(); }
async function current(page) { return page.evaluate(() => window.dreamEdge.workspace({ operation: 'current' })); }
async function storage(page, request) {
  return page.evaluate(async request => {
    const [tool] = await window.dreamEdge.tools(); return window.dreamEdge.storage(tool.id, request, tool.contextId);
  }, request);
}
async function findProject(id) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    for (const page of application.windows()) {
      try { if ((await current(page)).project?.definition.id === id) { await hello(page); return page; } } catch {}
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Project window was not restored');
}
try {
  let a = await launch();
  const pa = await a.evaluate(directory => window.dreamEdge.workspace({ operation: 'create', directory, name: 'Window A' }), join(source, 'A'));
  await hello(a);
  const wa = await a.evaluate(() => window.dreamEdge.windows({ operation: 'current' }));
  const created = application.waitForEvent('window');
  const wb = await a.evaluate(directory => window.dreamEdge.windows({ operation: 'createProject', directory, name: 'Window B' }), join(source, 'B'));
  let b = await created; await hello(b); const pb = (await current(b)).project;
  assert.equal((await current(a)).project.definition.id, pa.definition.id);
  assert.equal(wb.project.id, pb.definition.id);
  const tokenB = await b.evaluate(() => window.dreamEdge.tools());
  await assert.rejects(a.evaluate(tool => window.dreamEdge.storage(tool.id, { operation: 'list', collection: 'window-test' }, tool.contextId), tokenB[0]));
  await assert.rejects(a.evaluate(directory => window.dreamEdge.workspace({ operation: 'open', directory }), pb.rootDirectory));
  const duplicate = await a.evaluate(directory => window.dreamEdge.windows({ operation: 'openProject', directory }), pb.rootDirectory);
  assert.equal(duplicate.id, wb.id); assert.equal(application.windows().length, 2);
  await Promise.all([storage(a, { operation: 'put', collection: 'window-test', id: 'same', value: 'A' }),
    storage(b, { operation: 'put', collection: 'window-test', id: 'same', value: 'B' })]);
  await a.frameLocator('iframe').locator('body').evaluate(() => localStorage.setItem('same', 'A browser'));
  await b.frameLocator('iframe').locator('body').evaluate(() => localStorage.setItem('same', 'B browser'));
  await a.evaluate(() => localStorage.setItem('host-window', 'A'));
  await b.evaluate(() => localStorage.setItem('host-window', 'B'));
  const sessionB = await b.evaluate(projectId => window.dreamEdge.development({ operation: 'create', projectId, title: 'B session' }), pb.definition.id);
  const buildId = await verifyBuildPreview(application, a, pa);
  const restoredVersion = await verifyVersionSave(a, pa, buildId);
  assert.deepEqual(await storage(b, { operation: 'list', collection: 'window-test' }), [{ id: 'same', value: 'B' }]);
  assert.ok((await b.evaluate(projectId => window.dreamEdge.workspace({ operation: 'readFile', projectId, path: 'main.ts' }), pb.definition.id)).content.includes('HelloWorld'));
  assert.equal((await b.evaluate(projectId => window.dreamEdge.versions({ operation: 'status', projectId }), pb.definition.id)).versions.length, 0);
  const nativeA = await application.browserWindow(a); const nativeB = await application.browserWindow(b);
  await nativeA.evaluate(window => window.setBounds({ x: 40, y: 50, width: 980, height: 680 }));
  await nativeB.evaluate(window => window.setBounds({ x: 90, y: 80, width: 1020, height: 700 }));
  const boundsB = await nativeB.evaluate(window => window.getNormalBounds());
  const closedA = a.waitForEvent('close'); await nativeA.evaluate(window => window.close()); await closedA;
  assert.equal(application.windows().length, 1);
  assert.equal((await b.evaluate(({ projectId, sessionId }) => window.dreamEdge.development({ operation: 'get', projectId, sessionId }),
    { projectId: pb.definition.id, sessionId: sessionB.id })).id, sessionB.id);
  const reopened = application.waitForEvent('window');
  const opened = await b.evaluate(directory => window.dreamEdge.windows({ operation: 'openProject', directory }), pa.rootDirectory);
  a = await reopened; await hello(a); assert.equal(opened.id, wa.id);
  assert.deepEqual(await storage(a, { operation: 'list', collection: 'window-test' }), [{ id: 'same', value: 'A' }]);
  assert.equal(await a.frameLocator('iframe').locator('body').evaluate(() => localStorage.getItem('same')), 'A browser');
  await application.close(); await launch();
  a = await findProject(pa.definition.id); b = await findProject(pb.definition.id);
  assert.equal((await a.evaluate(() => window.dreamEdge.windows({ operation: 'current' }))).id, wa.id);
  assert.equal((await b.evaluate(() => window.dreamEdge.windows({ operation: 'current' }))).id, wb.id);
  assert.equal(await a.evaluate(() => localStorage.getItem('host-window')), 'A');
  assert.equal(await b.evaluate(() => localStorage.getItem('host-window')), 'B');
  assert.equal(await b.frameLocator('iframe').locator('body').evaluate(() => localStorage.getItem('same')), 'B browser');
  assert.deepEqual(await (await application.browserWindow(b)).evaluate(window => window.getNormalBounds()), boundsB);
  assert.equal((await a.evaluate(projectId => window.dreamEdge.versions({ operation: 'status', projectId }), pa.definition.id)).head, restoredVersion.versionId);
  assert.deepEqual(await storage(b, { operation: 'list', collection: 'window-test' }), [{ id: 'same', value: 'B' }]);
  await application.close(); await rename(pa.rootDirectory, join(source, 'A-missing'));
  const first = await launch(); b = await findProject(pb.definition.id);
  const list = await first.evaluate(() => window.dreamEdge.windows({ operation: 'list' }));
  assert.equal(list.length, 2); assert.ok(list.find(window => window.id === wa.id).recoveryError);
  assert.deepEqual(await storage(b, { operation: 'list', collection: 'window-test' }), [{ id: 'same', value: 'B' }]);
  console.log('PASS: independent project windows, scoped data/context, close/reopen and multi-window restart recovery.');
} finally {
  if (application) await application.close().catch(() => application.process().kill('SIGKILL'));
  await rm(profile, { recursive: true, force: true }); await rm(source, { recursive: true, force: true });
}
