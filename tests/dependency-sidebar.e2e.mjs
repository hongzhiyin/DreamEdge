import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { _electron as electron } from 'playwright';
import electronPath from 'electron';
import { packageRegistry } from './dependency-fixture.ts';

const profile = await mkdtemp(join(tmpdir(), 'dreamedge-dependencies-profile-'));
const source = await mkdtemp(join(tmpdir(), 'dreamedge-dependencies-source-'));
let application;
try {
  const fixture = await packageRegistry();
  const item = await fixture.add('dreamedge-greeting', '1.0.0', { 'index.js': "export const greeting='HelloWorld dependencies';" });
  const bytes = fixture.archives.get(item.tarball).toString('base64');
  const env = { ...process.env, DREAMEDGE_DATA_DIR: profile };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'DREAMEDGE_AI_API_KEY', 'DREAMEDGE_AI_MODEL', 'DREAMEDGE_AI_BASE_URL']) delete env[key];
  application = await electron.launch({ executablePath: process.env.DREAMEDGE_EXECUTABLE_PATH || electronPath,
    args: process.env.DREAMEDGE_EXECUTABLE_PATH ? [] : [resolve('.')], env });
  const page = await application.firstWindow(); const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.frameLocator('iframe').getByText('HelloWorld', { exact: true }).waitFor();
  await page.getByRole('button', { name: '打开开发侧栏' }).click();
  await application.evaluate(({ dialog }, directory) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: directory }); }, join(source, '依赖工程'));
  await page.getByRole('button', { name: /^新建工程/ }).click();
  await page.getByRole('region', { name: '依赖与构建' }).waitFor();
  const panel = page.getByRole('region', { name: '依赖与构建' });
  const project = await page.evaluate(async () => (await window.dreamEdge.workspace({ operation: 'current' })).project);
  await page.evaluate(async id => {
    const file = await window.dreamEdge.workspace({ operation: 'readFile', projectId: id, path: 'main.ts' });
    await window.dreamEdge.workspace({ operation: 'writeFile', projectId: id, path: 'main.ts', expectedHash: file.hash,
      content: "import { greeting } from 'dreamedge-greeting';document.body.textContent=greeting;" });
  }, project.definition.id);
  await application.evaluate((_electron, { item, bytes }) => {
    globalThis.fetch = async (input, options) => {
      const url = String(input); if (options?.redirect !== 'error') throw new Error('Missing redirect restriction');
      if (url === 'https://registry.npmjs.org/dreamedge-greeting/1.0.0') return new Response(JSON.stringify({ name: item.name, version: item.version,
        dependencies: {}, dist: { tarball: item.tarball, integrity: item.integrity } }));
      if (url === item.tarball) return new Response(Buffer.from(bytes, 'base64'));
      throw new Error('Unexpected registry URL');
    };
  }, { item, bytes });
  await panel.getByLabel('包名', { exact: true }).fill('dreamedge-greeting');
  await panel.getByLabel('版本', { exact: true }).fill('1.0.0');
  await panel.getByRole('button', { name: '添加依赖', exact: true }).click();
  await panel.getByRole('button', { name: '构建候选', exact: true }).click();
  await panel.getByText('构建成功，请预览并确认保存。', { exact: true }).waitFor();
  assert.deepEqual((await page.evaluate(() => window.dreamEdge.workspace({ operation: 'current' }))).project.definition.dependencies, {});
  const preview = application.waitForEvent('window');
  await panel.getByRole('button', { name: '预览候选', exact: true }).click();
  const previewPage = await preview; await previewPage.getByText('HelloWorld dependencies', { exact: true }).waitFor();
  assert.equal(await previewPage.evaluate(() => typeof window.dreamEdge), 'undefined');
  const nativePreview = await application.browserWindow(previewPage); await nativePreview.evaluate(window => window.close());
  await panel.getByRole('button', { name: '确认保存', exact: true }).click();
  await panel.getByText('已保存，依赖已随工程版本锁定。', { exact: true }).waitFor();
  const saved = (await page.evaluate(() => window.dreamEdge.workspace({ operation: 'current' }))).project;
  assert.equal(saved.definition.dependencies['dreamedge-greeting'], '1.0.0');
  assert.equal(saved.definition.dependencyLock.packages['node_modules/dreamedge-greeting'].integrity, item.integrity);
  await application.evaluate(() => { globalThis.fetch = async () => { throw new Error('Network must not be used for locked cached build'); }; });
  await panel.getByRole('button', { name: '构建候选', exact: true }).click();
  await panel.getByText('构建成功，请预览并确认保存。', { exact: true }).waitFor();
  const native = await application.browserWindow(page); await native.evaluate(window => window.setSize(840, 820));
  await panel.getByRole('button', { name: '构建候选', exact: true }).scrollIntoViewIfNeeded();
  await mkdir('artifacts', { recursive: true }); await page.screenshot({ path: 'artifacts/dreamedge-dependencies.png' });
  await native.evaluate(window => window.setSize(640, 480));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await panel.getByRole('button', { name: '移除 dreamedge-greeting' }).click();
  await panel.getByLabel('包名', { exact: true }).fill('dreamedge-greeting');
  await panel.getByLabel('版本', { exact: true }).fill('latest');
  await panel.getByRole('button', { name: '添加依赖', exact: true }).click();
  await panel.getByRole('button', { name: '构建候选', exact: true }).click();
  await panel.getByRole('alert').filter({ hasText: '准确版本' }).waitFor();
  assert.equal((await page.evaluate(() => window.dreamEdge.workspace({ operation: 'current' }))).project.definition.dependencies['dreamedge-greeting'], '1.0.0');
  await panel.getByRole('button', { name: '清理依赖缓存', exact: true }).click();
  await panel.getByText('依赖缓存已清理，下次构建将重新下载。', { exact: true }).waitFor();
  assert.deepEqual(errors, []);
  console.log('PASS: sidebar dependency edit/build/preview/confirm, locked cached rebuild and invalid-version feedback.');
} finally {
  if (application) {
    const closed = await Promise.race([application.close().then(() => true).catch(() => true), new Promise(resolve => setTimeout(() => resolve(false), 5000))]);
    if (!closed) application.process().kill('SIGKILL');
  }
  await rm(profile, { recursive: true, force: true }); await rm(source, { recursive: true, force: true });
}
