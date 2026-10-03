import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { _electron as electron } from 'playwright';
import electronPath from 'electron';
import { exportProject, replaceApp, appExecutable } from './export-acceptance.e2e.mjs';
import { upgradeModel } from './upgrade-model.e2e.mjs';
import { packageRegistry } from './dependency-fixture.ts';

if (process.platform !== 'darwin') { console.log('SKIP: development App export requires macOS.'); process.exit(0); }
const root = await mkdtemp(join(tmpdir(), 'dreamedge-editable-export-'));
const id = `io.example.editable${Date.now()}`; const apps = new Set(); const profiles = new Set(); const errors = [];
const source = "import {greeting} from 'editable-greeting';import {storage} from '@dreamedge/sdk';document.getElementById('root')!.textContent=greeting;const b=document.createElement('button');b.textContent='保存';b.onclick=async()=>{await storage.put('check','record','published');b.textContent='已保存';};document.body.append(b);";
const checksum = async path => createHash('sha256').update(await readFile(path)).digest('hex');
async function launch(path, expected, env = process.env) {
  const clean = { ...env }; delete clean.ELECTRON_RUN_AS_NODE;
  if (!env.DREAMEDGE_DATA_DIR) delete clean.DREAMEDGE_DATA_DIR;
  const app = await electron.launch({ executablePath: appExecutable(path), args: [], cwd: '/', env: clean }); apps.add(app);
  const page = await app.firstWindow(); page.setDefaultTimeout(20000); page.on('pageerror', error => errors.push(error.message));
  await page.frameLocator('iframe').getByText(expected, { exact: true }).waitFor();
  profiles.add(await app.evaluate(({ app }) => app.getPath('userData'))); return { app, page };
}
async function close(target) { await target.app.close(); apps.delete(target.app); }
const data = target => target.page.evaluate(async () => { const tool = (await window.dreamEdge.tools())[0]; return window.dreamEdge.storage(tool.id, { operation: 'list', collection: 'check' }, tool.contextId); });
async function settings(page) { await page.getByRole('button', { name: '打开工程设置' }).click(); await page.getByRole('tab', { name: '应用与导出' }).click(); }
try {
  const registry = await packageRegistry(); const item = await registry.add('editable-greeting', '1.0.0', { 'index.js': "export const greeting='Hello Editable';" });
  const env = { ...process.env, DREAMEDGE_DATA_DIR: join(root, 'framework-profile') }; delete env.ELECTRON_RUN_AS_NODE;
  const framework = await electron.launch({ executablePath: process.env.DREAMEDGE_EXECUTABLE_PATH || electronPath, args: process.env.DREAMEDGE_EXECUTABLE_PATH ? [] : [resolve('.')], cwd: '/', env }); apps.add(framework);
  const page = await framework.firstWindow(); page.setDefaultTimeout(20000); await page.frameLocator('iframe').getByText('HelloWorld', { exact: true }).waitFor();
  const directory = join(root, 'source');
  let project = await page.evaluate(directory => window.dreamEdge.workspace({ operation: 'create', directory, name: 'Editable project' }), directory);
  await page.evaluate(async ({ projectId, source, appId }) => {
    const before = await window.dreamEdge.workspace({ operation: 'readFile', projectId, path: 'main.ts' });
    await window.dreamEdge.workspace({ operation: 'writeFile', projectId, path: 'main.ts', content: source, expectedHash: before.hash });
    await window.dreamEdge.workspace({ operation: 'save', projectId, appName: 'Editable Fixture', appId, version: '1.0.0' });
    await window.dreamEdge.workspace({ operation: 'close' });
  }, { projectId: project.definition.id, source, appId: id });
  const definitionPath = join(project.rootDirectory, '.dreamedge/project.json'); const definition = JSON.parse(await readFile(definitionPath, 'utf8'));
  definition.dependencies = { 'editable-greeting': '1.0.0' }; definition.dependencyLock = { schemaVersion: 1, registry: 'https://registry.npmjs.org', dependencies: definition.dependencies, packages: { 'node_modules/editable-greeting': item } };
  await writeFile(definitionPath, JSON.stringify(definition));
  await framework.evaluate((_electron, { url, bytes }) => { globalThis.fetch = async value => {
    if (String(value) !== url) throw new Error('Unexpected dependency request'); return new Response(Uint8Array.from(bytes));
  }; }, { url: item.tarball, bytes: [...registry.archives.get(item.tarball)] });
  project = await page.evaluate(directory => window.dreamEdge.workspace({ operation: 'open', directory }), project.rootDirectory);
  await page.frameLocator('iframe').getByText('Hello Editable', { exact: true }).waitFor();
  await page.evaluate(async projectId => { const state = await window.dreamEdge.modelSettings({ operation: 'get', projectId }); await window.dreamEdge.modelSettings({ operation: 'save', projectId, expectedRevision: state.revision, apiKey: 'fixture-export-secret', model: 'fixture', baseUrl: 'https://model.example/v1' }); }, project.definition.id);
  await page.getByRole('button', { name: '打开开发侧栏' }).click(); await settings(page);
  const plain = await exportProject(framework, page, project, join(root, 'plain'));
  const editablePath = await exportProject(framework, page, project, join(root, 'editable'), 'development');
  const installed = join(root, 'Installed/Editable Fixture.app'); await replaceApp(plain, installed);
  let current = await launch(installed, 'Hello Editable');
  await current.page.frameLocator('iframe').getByRole('button', { name: '保存', exact: true }).click(); await current.page.frameLocator('iframe').getByRole('button', { name: '已保存', exact: true }).waitFor(); await close(current);
  await replaceApp(editablePath, installed); const appHash = await checksum(join(installed, 'Contents/Resources/app.asar'));
  current = await launch(installed, 'Hello Editable');
  const local = (await current.page.evaluate(() => window.dreamEdge.workspace({ operation: 'current' }))).project;
  const localProfile = await current.app.evaluate(({ app }) => app.getPath('userData'));
  assert.ok(local.rootDirectory.startsWith(localProfile + '/')); assert.notEqual(local.definition.id, project.definition.id);
  assert.deepEqual(await data(current), [{ id: 'record', value: 'published' }]);
  const model = await current.page.evaluate(projectId => window.dreamEdge.modelSettings({ operation: 'get', projectId }), local.definition.id); assert.equal(model.hasKey, false);
  await access(join(local.rootDirectory, '.git')); await assert.rejects(access(join(local.rootDirectory, '.dreamedge/model.json')));
  await assert.rejects(current.page.evaluate(() => window.dreamEdge.windows({ operation: 'new' })), /自身/);
  await assert.rejects(current.page.evaluate(() => window.dreamEdge.projectAction('createProject')), /自身/);
  await current.page.evaluate(async projectId => {
    const state = await window.dreamEdge.modelSettings({ operation: 'get', projectId });
    await window.dreamEdge.modelSettings({ operation: 'save', projectId, expectedRevision: state.revision, apiKey: 'fixture-upgrade-key', model: 'fixture', baseUrl: 'https://model.example/v1' });
  }, local.definition.id);
  await upgradeModel(current.app, 'Hello Local Edit');
  await current.page.getByRole('button', { name: '打开开发侧栏' }).click();
  const chat = current.page.getByRole('region', { name: 'AI 会话' });
  await chat.getByLabel('修改需求', { exact: true }).fill('修改本应用'); await chat.getByRole('button', { name: '发送给 AI', exact: true }).click();
  await current.page.frameLocator('iframe').getByText('Hello Local Edit', { exact: true }).waitFor(); await chat.getByText('修改已应用，页面已自动刷新。', { exact: true }).waitFor();
  assert.match(await readFile(join(local.sourceDirectory, 'main.ts'), 'utf8'), /Hello Local Edit/);
  assert.equal(await checksum(join(installed, 'Contents/Resources/app.asar')), appHash);
  await settings(current.page); await current.page.getByRole('tab', { name: 'Git 历史' }).click();
  await current.page.getByLabel('提交说明').fill('Local edit in exported App'); await current.page.getByRole('button', { name: '提交当前修改' }).click(); await current.page.getByText('工程修改已提交 Git。', { exact: true }).waitFor();
  await current.page.getByRole('tab', { name: '应用与导出' }).click(); assert.equal(await current.page.getByLabel('应用标识', { exact: true }).isEnabled(), false);
  const saved = (await current.page.evaluate(() => window.dreamEdge.workspace({ operation: 'current' }))).project;
  const nested = await exportProject(current.app, current.page, saved, join(root, 'reexport'));
  await mkdir('artifacts', { recursive: true }); await current.page.screenshot({ path: 'artifacts/dreamedge-development-reexport.png' });
  await current.page.getByRole('tab', { name: '工程管理' }).click(); assert.equal(await current.page.getByRole('button', { name: /^新建工程/ }).count(), 0);
  await current.app.evaluate(({ shell }) => { globalThis.revealed = ''; shell.showItemInFolder = path => { globalThis.revealed = path; }; });
  await current.page.getByRole('button', { name: '在 Finder 中查看工程' }).click(); assert.equal(await current.app.evaluate(() => globalThis.revealed), local.rootDirectory);
  await close(current); await close({ app: framework }); await rm(directory, { recursive: true, force: true });
  await replaceApp(editablePath, installed); current = await launch(installed, 'Hello Local Edit');
  assert.equal((await current.page.evaluate(() => window.dreamEdge.workspace({ operation: 'current' }))).project.definition.id, local.definition.id);
  assert.equal((await current.page.evaluate(id => window.dreamEdge.modelSettings({ operation: 'get', projectId: id }), local.definition.id)).hasKey, true);
  assert.equal((await current.page.evaluate(id => window.dreamEdge.development({ operation: 'listSummaries', projectId: id }), local.definition.id))[0].turnCount, 1);
  assert.deepEqual(await data(current), [{ id: 'record', value: 'published' }]); await close(current);
  await replaceApp(nested, installed); current = await launch(installed, 'Hello Local Edit'); assert.equal(await current.page.getByRole('button', { name: '打开开发侧栏' }).count(), 0);
  assert.deepEqual(await data(current), [{ id: 'record', value: 'published' }]);
  assert.deepEqual(errors, []);
  console.log('PASS: standard→development→standard preserves business data; exported App boots its isolated offline workspace, runs AI/Git, reexports without original framework, preserves local source/key/session through replacement and keeps app.asar unchanged.');
} catch (error) {
  for (const app of apps) { const page = app.windows()[0]; if (page) console.error(await page.locator('body').textContent().catch(() => 'No diagnostics')); }
  throw error;
} finally {
  for (const app of apps) await app.close().catch(() => app.process().kill('SIGKILL'));
  if (!process.env.DREAMEDGE_KEEP_EXPORT_FIXTURE) for (const profile of profiles) await rm(profile, { recursive: true, force: true });
  else console.log('Development profiles:', [...profiles]);
  if (process.env.DREAMEDGE_KEEP_EXPORT_FIXTURE) console.log('Development export fixture:', root); else await rm(root, { recursive: true, force: true });
}
