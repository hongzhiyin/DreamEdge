import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';
import electronPath from 'electron';

if (process.platform !== 'darwin') { console.log('SKIP: macOS App export acceptance.'); process.exit(0); }
const root = await mkdtemp(join(tmpdir(), 'dreamedge-export-app-')); const profile = join(root, 'profile');
const id = `io.example.export${Date.now()}`; const exported = []; const apps = []; const profiles = []; let framework;
const sdkSource = value => `import {storage} from '@dreamedge/sdk';document.getElementById('root')!.textContent='Hello ${value}';\nconst b=document.createElement('button');b.textContent='保存';b.onclick=async()=>{await storage.put('check','same-key','${value}');b.textContent='已保存';};document.body.append(b);`;
async function launchApp(path) {
  const env = { ...process.env }; for (const key of ['ELECTRON_RUN_AS_NODE', 'DREAMEDGE_DATA_DIR']) delete env[key];
  const app = await electron.launch({ executablePath: join(path, 'Contents/MacOS', path.split('/').at(-1).slice(0, -4)), args: [], env });
  apps.push(app); const page = await app.firstWindow(); page.setDefaultTimeout(20000); await page.locator('iframe').waitFor();
  const manifest = await page.evaluate(() => window.dreamEdge.info()); profiles.push(await app.evaluate(({ app }) => app.getPath('userData')));
  assert.equal(await page.getByRole('button', { name: '打开开发侧栏' }).count(), 0);
  await assert.rejects(page.evaluate(id => window.dreamEdge.exportApp({ operation: 'current', projectId: id }), 'foreign'), /未启用 App 导出/);
  return { app, page, manifest };
}
try {
  const env = { ...process.env, DREAMEDGE_DATA_DIR: profile }; delete env.ELECTRON_RUN_AS_NODE;
  framework = await electron.launch({ executablePath: process.env.DREAMEDGE_EXECUTABLE_PATH || electronPath,
    args: process.env.DREAMEDGE_EXECUTABLE_PATH ? [] : [resolve('.')], cwd: '/', env });
  const page = await framework.firstWindow(); page.setDefaultTimeout(20000); const errors = [];
  page.on('pageerror', error => errors.push(error.message)); await page.frameLocator('iframe').getByText('HelloWorld', { exact: true }).waitFor();
  await page.getByRole('button', { name: '打开开发侧栏' }).click();
  for (const label of ['Alpha', 'Beta']) {
    const directory = join(root, `source-${label}`); const output = join(root, `export-${label}`);
    await framework.evaluate(({ dialog }, directory) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: directory }); }, directory);
    if (label === 'Alpha') await page.getByRole('button', { name: /^新建工程/ }).click();
    else await page.evaluate(async directory => { await window.dreamEdge.workspace({ operation: 'close' }); await window.dreamEdge.workspace({ operation: 'create', directory, name: 'Beta' }); }, directory);
    if (label === 'Alpha') await page.waitForFunction(() => !document.querySelector('.sidebar-action')?.disabled);
    const project = (await page.evaluate(() => window.dreamEdge.workspace({ operation: 'current' }))).project;
    await page.evaluate(async ({ projectId, content }) => {
      const before = await window.dreamEdge.workspace({ operation: 'readFile', projectId, path: 'main.ts' });
      await window.dreamEdge.workspace({ operation: 'writeFile', projectId, path: 'main.ts', content, expectedHash: before.hash });
      const settings = await window.dreamEdge.modelSettings({ operation: 'get', projectId });
      await window.dreamEdge.modelSettings({ operation: 'save', projectId, expectedRevision: settings.revision, model: 'fixture', baseUrl: 'https://model.example/v1', apiKey: 'fixture-export-secret' });
    }, { projectId: project.definition.id, content: sdkSource(label) });
    await page.getByRole('button', { name: '打开工程设置' }).click(); await page.getByRole('tab', { name: '应用与导出' }).click();
    const panel = page.getByRole('region', { name: '应用与导出' });
    await panel.getByLabel('应用名称', { exact: true }).fill(`Export ${label}`); await panel.getByLabel('应用标识', { exact: true }).fill(`${id}${label.toLowerCase()}`);
    await panel.getByLabel('应用版本', { exact: true }).fill('1.2.3');
    assert.equal(await panel.getByRole('button', { name: '导出 macOS App' }).isEnabled(), false);
    await panel.getByRole('button', { name: '保存应用信息' }).click(); await panel.getByText('应用信息已保存。', { exact: true }).waitFor();
    const saved = (await page.evaluate(() => window.dreamEdge.workspace({ operation: 'current' }))).project;
    assert.equal(saved.definition.name, project.definition.name); assert.equal(saved.definition.appName, `Export ${label}`);
    assert.equal(saved.rootDirectory, project.rootDirectory);
    assert.ok((await framework.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getTitle())).includes(project.definition.name));
    await page.frameLocator('iframe').getByText(`Hello ${label}`, { exact: true }).waitFor();
    await framework.evaluate(({ dialog }, output) => { dialog.showSaveDialog = async (_parent, options) => {
      if (options.defaultPath !== `Export ${output.endsWith('Alpha') ? 'Alpha' : 'Beta'}-导出`) throw new Error('Wrong application name');
      if (options.buttonLabel !== '导出') throw new Error('Wrong export dialog'); return { canceled: false, filePath: output };
    }; }, output);
    await panel.getByRole('button', { name: '导出 macOS App' }).click();
    const deadline = Date.now() + 180000; let record;
    while (Date.now() < deadline) {
      record = (await page.evaluate(id => window.dreamEdge.exportApp({ operation: 'current', projectId: id }), project.definition.id)).record;
      if (record && record.status !== 'running') break; await new Promise(resolve => setTimeout(resolve, 500));
    }
    assert.equal(record?.status, 'succeeded', record?.error ?? 'Export timed out');
    await panel.getByText('业务 App 已导出。', { exact: true }).waitFor();
    const files = await readdir(output); const app = files.find(name => name.endsWith('.app')); assert.ok(app && files.some(name => name.endsWith('.zip')));
    const descriptor = JSON.parse(await readFile(join(output, '工程/.dreamedge/project.json'), 'utf8'));
    assert.equal(app, `Export ${label}.app`);
    assert.equal(descriptor.name, project.definition.name); assert.equal(descriptor.appName, `Export ${label}`);
    assert.notEqual(descriptor.id, project.definition.id); assert.equal(descriptor.appId, `${id}${label.toLowerCase()}`);
    for (const file of ['.dreamedge/model.json', '.git', 'data', 'sessions']) await assert.rejects(access(join(output, '工程', file)));
    const asar = createRequire(import.meta.url)('@electron/asar'); const archive = join(output, app, 'Contents/Resources/app.asar');
    const entries = asar.listPackage(archive); assert.ok(!entries.some(path => /model\.json|records\.sqlite|session\.json/.test(path)));
    assert.ok(!asar.extractFile(archive, 'dist/app.json').toString().includes('fixture-export-secret'));
    exported.push(join(output, app));
    await mkdir('artifacts', { recursive: true }); await page.screenshot({ path: `artifacts/dreamedge-export-${label.toLowerCase()}.png` });
    await page.getByRole('button', { name: '返回 AI 对话' }).click();
  }
  await framework.close(); framework = undefined;
  for (const label of ['Alpha', 'Beta']) await rm(join(root, `source-${label}`), { recursive: true, force: true });
  const a = await launchApp(exported[0]); const b = await launchApp(exported[1]); assert.notEqual(a.manifest.appId, b.manifest.appId); assert.notEqual(profiles[0], profiles[1]);
  for (const [target, label] of [[a, 'Alpha'], [b, 'Beta']]) {
    await target.page.frameLocator('iframe').getByText(`Hello ${label}`, { exact: true }).waitFor();
    await target.page.frameLocator('iframe').getByRole('button', { name: '保存', exact: true }).click(); await target.page.frameLocator('iframe').getByRole('button', { name: '已保存', exact: true }).waitFor();
    assert.equal(await target.page.evaluate(async id => (await window.dreamEdge.storage(id, { operation: 'list', collection: 'check' }))[0].value, target.manifest.id), label);
  }
  await a.app.close(); apps.splice(apps.indexOf(a.app), 1); const reopened = await launchApp(exported[0]);
  assert.equal(await reopened.page.evaluate(async id => (await window.dreamEdge.storage(id, { operation: 'list', collection: 'check' }))[0].value, reopened.manifest.id), 'Alpha');
  assert.deepEqual(errors, []); console.log('PASS: in-app settings/export, standalone signed apps and ZIP, secret/data exclusion, SDK storage, two simultaneous independent identities and restart persistence.');
} catch (error) {
  if (framework) { const page = framework.windows()[0]; console.error(await page?.getByRole('region', { name: '应用与导出' }).textContent().catch(() => 'No export panel')); }
  throw error;
} finally {
  if (framework) await framework.close(); for (const app of apps) await app.close();
  if (!process.env.DREAMEDGE_KEEP_EXPORT_FIXTURE) await rm(root, { recursive: true, force: true }); else console.log('Export fixture:', root); for (const profile of new Set(profiles)) await rm(profile, { recursive: true, force: true });
}
