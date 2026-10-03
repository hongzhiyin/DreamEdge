import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { _electron as electron } from 'playwright';
import electronPath from 'electron';
const root = await mkdtemp(join(tmpdir(), 'dreamedge-project-name-')); let application;
async function launch(expected) {
  const env = { ...process.env, DREAMEDGE_DATA_DIR: join(root, 'profile') };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'DREAMEDGE_AI_API_KEY', 'DREAMEDGE_AI_MODEL', 'DREAMEDGE_AI_BASE_URL']) delete env[key];
  application = await electron.launch({ executablePath: process.env.DREAMEDGE_EXECUTABLE_PATH || electronPath,
    args: process.env.DREAMEDGE_EXECUTABLE_PATH ? [] : [resolve('.')], env });
  const page = await application.firstWindow(); page.setDefaultTimeout(15000);
  await page.frameLocator('iframe').getByText('HelloWorld', { exact: true }).waitFor();
  const native = await application.browserWindow(page);
  if (expected) assert.equal(await native.evaluate(window => window.getTitle()), `DreamEdge · ${expected}`);
  return { page, native };
}
try {
  let { page, native } = await launch(); const errors = []; page.on('pageerror', error => errors.push(error.message));
  const directory = join(root, 'UsageLookup');
  await application.evaluate(({ dialog }, path) => { dialog.showSaveDialog = async (_parent, options) => {
    if (options.defaultPath.endsWith('DreamEdge工程') || options.nameFieldLabel !== '新工程文件夹名称：') throw new Error('Default project name still present');
    return { canceled: false, filePath: path };
  }; }, directory);
  await page.getByRole('button', { name: '打开开发侧栏' }).click(); await page.getByRole('button', { name: /^新建工程/ }).click();
  await page.locator('.sidebar-project-name').getByText('UsageLookup', { exact: true }).waitFor();
  assert.equal(await native.evaluate(window => window.getTitle()), 'DreamEdge · UsageLookup');
  const before = (await page.evaluate(() => window.dreamEdge.workspace({ operation: 'current' }))).project;
  await writeFile(join(directory, '.dreamedge/model.json'), 'fixture-private-key'); await writeFile(join(before.dataDirectory, 'kept'), 'Business data');
  const head = (await page.evaluate(id => window.dreamEdge.git({ operation: 'status', projectId: id }), before.definition.id)).head;
  await page.getByRole('button', { name: '打开工程设置' }).click(); await page.getByRole('tab', { name: '工程管理', exact: true }).click();
  await page.getByLabel('工程名称', { exact: true }).fill('Renamed project'); await page.getByRole('button', { name: '保存工程名称', exact: true }).click();
  await page.getByText('工程名称已保存，窗口标题已更新。', { exact: true }).waitFor();
  await page.locator('.sidebar-project-name').getByText('Renamed project', { exact: true }).waitFor();
  assert.equal(await native.evaluate(window => window.getTitle()), 'DreamEdge · Renamed project');
  const after = (await page.evaluate(() => window.dreamEdge.workspace({ operation: 'current' }))).project;
  assert.equal(after.rootDirectory, before.rootDirectory); assert.equal(after.definition.id, before.definition.id); assert.equal(after.definition.appName, 'UsageLookup'); assert.equal(after.definition.appId, before.definition.appId);
  assert.equal((await page.evaluate(id => window.dreamEdge.git({ operation: 'status', projectId: id }), after.definition.id)).head, head);
  assert.equal(await readFile(join(directory, '.dreamedge/model.json'), 'utf8'), 'fixture-private-key'); assert.equal(await readFile(join(before.dataDirectory, 'kept'), 'utf8'), 'Business data');
  await page.getByRole('tab', { name: '应用与导出', exact: true }).click(); assert.equal(await page.getByLabel('应用名称', { exact: true }).inputValue(), 'UsageLookup');
  await page.getByLabel('应用名称', { exact: true }).fill('Exported application'); await page.getByRole('button', { name: '保存应用信息', exact: true }).click();
  await page.getByText('应用信息已保存。', { exact: true }).waitFor(); assert.equal(await native.evaluate(window => window.getTitle()), 'DreamEdge · Renamed project');
  await page.frameLocator('iframe').getByText('HelloWorld', { exact: true }).waitFor();
  await page.getByRole('tab', { name: '工程管理', exact: true }).click(); await mkdir('artifacts', { recursive: true }); await page.screenshot({ path: 'artifacts/dreamedge-project-name.png' });
  await application.close(); ({ page, native } = await launch('Renamed project'));
  const restored = (await page.evaluate(() => window.dreamEdge.workspace({ operation: 'current' }))).project;
  assert.equal(restored.definition.name, 'Renamed project'); assert.equal(restored.definition.appName, 'Exported application'); assert.deepEqual(errors, []);
  console.log('PASS: explicit creation name, matching title/sidebar, editable project name, independent export name, unchanged directory/identity/Git/key/data and restart persistence.');
} finally { if (application) await application.close(); await rm(root, { recursive: true, force: true }); }
