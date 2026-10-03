import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { _electron as electron } from 'playwright';
import electronPath from 'electron';

const profile = await mkdtemp(join(tmpdir(), 'dreamedge-menu-profile-'));
const source = await mkdtemp(join(tmpdir(), 'dreamedge-menu-source-'));
let application;
async function waitProject(page) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      const state = await page.evaluate(() => window.dreamEdge.workspace({ operation: 'current' }));
      if (state.project) { await page.frameLocator('iframe').getByText('HelloWorld', { exact: true }).waitFor(); return state.project; }
    } catch (error) { if (!error.message.includes('切换工程')) throw error; }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Menu did not open a project: ' + JSON.stringify(await page.evaluate(() => window.dreamEdge.windows({ operation: 'list' }))));
}
async function click(page, id) {
  const native = await application.browserWindow(page);
  await application.evaluate(({ app }) => app.focus({ steal: true }));
  await native.evaluate(window => new Promise((resolve, reject) => {
    if (window.isFocused()) { resolve(); return; }
    const timer = setTimeout(() => reject(new Error('Project menu window did not receive focus')), 5000);
    window.once('focus', () => { clearTimeout(timer); resolve(); }); window.focus();
  }));
  await application.evaluate(({ Menu }, id) => {
    const item = Menu.getApplicationMenu().getMenuItemById(id);
    if (!item) throw new Error('Missing project menu command'); item.click();
  }, id);
}
try {
  const env = { ...process.env, DREAMEDGE_DATA_DIR: profile };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'DREAMEDGE_AI_API_KEY', 'DREAMEDGE_AI_MODEL', 'DREAMEDGE_AI_BASE_URL']) delete env[key];
  application = await electron.launch({ executablePath: process.env.DREAMEDGE_EXECUTABLE_PATH || electronPath,
    args: process.env.DREAMEDGE_EXECUTABLE_PATH ? [] : [resolve('.')], env });
  const a = await application.firstWindow(); await a.frameLocator('iframe').getByText('HelloWorld', { exact: true }).waitFor();
  const newDirectory = join(source, '工程 A');
  await application.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async (...args) => {
      const options = args.at(-1);
      if (options.buttonLabel !== '创建工程' || options.nameFieldLabel !== '新工程文件夹名称：' || options.defaultPath.endsWith('DreamEdge工程')) throw new Error('Invalid create dialog');
      return { canceled: false, filePath };
    };
    dialog.showMessageBox = async () => { throw new Error('Unexpected project error dialog'); };
  }, newDirectory);
  await click(a, 'project-new'); const pa = await waitProject(a);
  assert.equal(pa.definition.name, '工程 A'); assert.equal(application.windows().length, 1);
  assert.ok((await a.evaluate(() => document.querySelector('iframe').src)).includes(pa.definition.id.replaceAll('-', '')));
  await application.evaluate(({ dialog }) => { dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] }); });
  await click(a, 'project-open');
  assert.equal((await a.evaluate(() => window.dreamEdge.workspace({ operation: 'current' }))).project.definition.id, pa.definition.id);
  const created = application.waitForEvent('window'); await click(a, 'project-window');
  const b = await created; await b.frameLocator('iframe').getByText('HelloWorld', { exact: true }).waitFor();
  const existing = join(source, 'existing-project'); const id = randomUUID();
  await mkdir(join(existing, 'src'), { recursive: true }); await mkdir(join(existing, '.dreamedge'));
  await writeFile(join(existing, 'src/index.html'), '<div id="root"></div><script type="module" src="./main.ts"></script>');
  await writeFile(join(existing, 'src/main.ts'), "document.getElementById('root').textContent = 'HelloWorld';");
  await writeFile(join(existing, '.dreamedge/project.json'), JSON.stringify({ schemaVersion: 1, id, name: '工程 B',
    appId: `io.example.p${id.replaceAll('-', '')}`, version: '0.1.0', source: 'src', dependencies: {},
    build: { kind: 'web', entry: 'index.html' }, savedAt: new Date().toISOString() }));
  await application.evaluate(({ dialog }, directory) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] }); }, existing);
  await click(b, 'project-open'); const pb = await waitProject(b);
  assert.equal(pb.definition.id, id); assert.equal(application.windows().length, 2);
  await click(a, 'project-open');
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(application.windows().length, 2);
  assert.equal((await a.evaluate(() => window.dreamEdge.workspace({ operation: 'current' }))).project.definition.id, pa.definition.id);
  assert.equal((await b.evaluate(() => window.dreamEdge.workspace({ operation: 'current' }))).project.definition.id, pb.definition.id);
  console.log('PASS: native project menu creates/opens projects, cancels safely and opens independent windows.');
} finally {
  if (application) await application.close().catch(() => application.process().kill('SIGKILL'));
  await rm(profile, { recursive: true, force: true }); await rm(source, { recursive: true, force: true });
}
