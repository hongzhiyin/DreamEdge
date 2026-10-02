import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { _electron as electron } from 'playwright';
import electronPath from 'electron';

const profile = await mkdtemp(join(tmpdir(), 'dreamedge-sidebar-profile-'));
const source = await mkdtemp(join(tmpdir(), 'dreamedge-sidebar-source-'));
let application;
try {
  const env = { ...process.env, DREAMEDGE_DATA_DIR: profile };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'DREAMEDGE_AI_API_KEY', 'DREAMEDGE_AI_MODEL', 'DREAMEDGE_AI_BASE_URL']) delete env[key];
  application = await electron.launch({ executablePath: process.env.DREAMEDGE_EXECUTABLE_PATH || electronPath,
    args: process.env.DREAMEDGE_EXECUTABLE_PATH ? [] : [resolve('.')], env });
  const a = await application.firstWindow(); const errors = [];
  a.on('pageerror', error => errors.push(error.message));
  await a.frameLocator('iframe').getByText('HelloWorld', { exact: true }).waitFor();
  const toggle = a.getByRole('button', { name: '打开开发侧栏' });
  const sidebar = a.getByRole('complementary', { name: '开发侧栏' });
  await toggle.waitFor(); assert.equal(await sidebar.count(), 0);
  await mkdir('artifacts', { recursive: true });
  await a.screenshot({ path: 'artifacts/dreamedge-sidebar-closed.png' });
  await toggle.focus(); await a.keyboard.press('Enter'); await sidebar.waitFor();
  await a.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === '收起开发侧栏');
  assert.equal(await sidebar.getByText('未打开工程', { exact: true }).count(), 1);
  await a.waitForFunction(() => getComputedStyle(document.querySelector('aside')).transform === 'matrix(1, 0, 0, 1, 0, 0)');
  await a.screenshot({ path: 'artifacts/dreamedge-sidebar-open.png' });
  await a.keyboard.press('Escape'); await toggle.waitFor();
  await a.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === '打开开发侧栏');
  await toggle.click();
  const directory = join(source, '侧栏工程 A');
  const nativeA = await application.browserWindow(a); const ownerId = await nativeA.evaluate(window => window.id);
  await application.evaluate(({ dialog }, { directory, ownerId }) => {
    dialog.showSaveDialog = async (parent, options) => {
      if (parent.id !== ownerId || options.buttonLabel !== '创建工程') throw new Error('Wrong dialog owner');
      await new Promise(resolve => setTimeout(resolve, 100));
      return { canceled: false, filePath: directory };
    };
  }, { directory, ownerId });
  await sidebar.getByRole('button', { name: /^新建工程/ }).click();
  await sidebar.getByText('侧栏工程 A', { exact: true }).waitFor();
  const pa = await a.evaluate(() => window.dreamEdge.windows({ operation: 'current' }));
  assert.equal(pa.project.rootDirectory, await realpath(directory)); assert.equal(application.windows().length, 1);
  const opened = application.waitForEvent('window');
  await sidebar.getByRole('button', { name: /^新窗口/ }).click();
  const b = await opened; await b.frameLocator('iframe').getByText('HelloWorld', { exact: true }).waitFor();
  assert.equal(await b.getByRole('complementary').count(), 0);
  await b.getByRole('button', { name: '打开开发侧栏' }).click();
  const sidebarB = b.getByRole('complementary');
  await application.evaluate(({ dialog }) => { dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] }); });
  await sidebarB.getByRole('button', { name: /^打开工程/ }).click();
  await sidebarB.getByRole('button', { name: /^打开工程/ }).waitFor({ state: 'visible' });
  await b.waitForFunction(() => !document.querySelector('.sidebar-action').disabled);
  assert.equal(await sidebarB.getByRole('alert').count(), 0);
  assert.equal((await b.evaluate(() => window.dreamEdge.windows({ operation: 'current' }))).project, null);
  const nativeB = await application.browserWindow(b); const ownerB = await nativeB.evaluate(window => window.id);
  // Focus another window while invoking B: dialog ownership must follow the sender.
  await nativeA.evaluate(window => window.focus());
  await application.evaluate(({ dialog }, { directory, ownerB }) => {
    dialog.showOpenDialog = async (parent) => {
      if (parent.id !== ownerB) throw new Error('Wrong dialog owner');
      return { canceled: false, filePaths: [directory] };
    };
  }, { directory, ownerB });
  await b.evaluate(() => document.querySelectorAll('.sidebar-action')[1].click());
  await b.waitForFunction(() => !document.querySelector('.sidebar-action').disabled);
  assert.equal(application.windows().length, 2);
  assert.equal((await b.evaluate(() => window.dreamEdge.windows({ operation: 'current' }))).project, null);
  assert.equal((await a.evaluate(() => window.dreamEdge.windows({ operation: 'current' }))).project.id, pa.project.id);
  await application.evaluate(({ dialog }, directory) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] });
  }, join(source, 'missing'));
  await sidebarB.getByRole('button', { name: /^打开工程/ }).click();
  await sidebarB.getByRole('alert').filter({ hasText: '无法打开这个位置' }).waitFor();
  await b.emulateMedia({ reducedMotion: 'reduce' });
  await nativeB.evaluate(window => window.setSize(640, 480));
  assert.equal(await sidebarB.evaluate(element => getComputedStyle(element).transitionDuration), '0s');
  assert.equal(await b.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await sidebarB.getByRole('button', { name: '收起开发侧栏' }).click();
  await b.getByRole('button', { name: '打开开发侧栏' }).waitFor();
  assert.equal(await b.getByRole('complementary').count(), 0);
  await assert.rejects(b.evaluate(() => window.dreamEdge.projectAction('invalid')), /不支持的工程操作/);
  assert.equal(await a.frameLocator('iframe').locator('body').evaluate(() => typeof window.dreamEdge), 'undefined');
  assert.deepEqual(errors, []);
  console.log('PASS: collapsed sidebar, keyboard focus, native project actions, per-window ownership, cancellation and errors.');
} finally {
  if (application) {
    const closed = await Promise.race([application.close().then(() => true).catch(() => true), new Promise(resolve => setTimeout(() => resolve(false), 5000))]);
    if (!closed) application.process().kill('SIGKILL');
  }
  await rm(profile, { recursive: true, force: true }); await rm(source, { recursive: true, force: true });
}
