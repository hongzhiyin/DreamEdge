import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { _electron as electron } from 'playwright';
import electronPath from 'electron';

const profile = await mkdtemp(join(tmpdir(), 'dreamedge-react-profile-'));
const source = await mkdtemp(join(tmpdir(), 'dreamedge-react-source-'));
let application; let project;
try {
  const env = { ...process.env, DREAMEDGE_DATA_DIR: profile };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'DREAMEDGE_AI_API_KEY', 'DREAMEDGE_AI_MODEL', 'DREAMEDGE_AI_BASE_URL']) delete env[key];
  application = await electron.launch({ executablePath: process.env.DREAMEDGE_EXECUTABLE_PATH || electronPath,
    args: process.env.DREAMEDGE_EXECUTABLE_PATH ? [] : [resolve('.')], env });
  const page = await application.firstWindow(); await page.frameLocator('iframe').getByText('HelloWorld', { exact: true }).waitFor();
  project = await page.evaluate(directory => window.dreamEdge.workspace({ operation: 'create', directory, name: 'React HelloWorld' }), join(source, 'react'));
  await page.evaluate(async id => {
    const html = await window.dreamEdge.workspace({ operation: 'readFile', projectId: id, path: 'index.html' });
    await window.dreamEdge.workspace({ operation: 'writeFile', projectId: id, path: 'index.html', expectedHash: html.hash,
      content: '<!doctype html><html><meta charset="UTF-8"><div id="root"></div><script type="module" src="./main.tsx"></script></html>' });
    await window.dreamEdge.workspace({ operation: 'writeFile', projectId: id, path: 'main.tsx', expectedHash: null,
      content: "import {createRoot} from 'react-dom/client';createRoot(document.getElementById('root')!).render(<main>HelloWorld React</main>);" });
  }, project.definition.id);
  await page.getByRole('button', { name: '打开开发侧栏' }).click();
  const panel = page.getByRole('region', { name: '依赖与构建' }); await panel.waitFor();
  for (const name of ['react', 'react-dom']) {
    await panel.getByLabel('包名', { exact: true }).fill(name); await panel.getByLabel('版本', { exact: true }).fill('19.2.0');
    await panel.getByRole('button', { name: '添加依赖', exact: true }).click();
  }
  await panel.getByRole('button', { name: '构建候选', exact: true }).click();
  await panel.getByRole('status').filter({ hasText: /构建成功|构建未完成/ }).waitFor({ timeout: 120000 });
  assert.equal(await panel.getByText('构建成功，请预览并确认保存。', { exact: true }).count(), 1, await panel.innerText());
  const opened = application.waitForEvent('window'); await panel.getByRole('button', { name: '预览候选', exact: true }).click();
  const preview = await opened; await preview.getByText('HelloWorld React', { exact: true }).waitFor();
  assert.equal(await preview.evaluate(() => typeof window.dreamEdge), 'undefined');
  await mkdir('artifacts', { recursive: true }); await preview.screenshot({ path: 'artifacts/react-locked-preview.png' });
  await (await application.browserWindow(preview)).evaluate(window => window.close());
  await panel.getByRole('button', { name: '确认保存', exact: true }).click();
  await panel.getByText('已保存，依赖已随工程版本锁定。', { exact: true }).waitFor();
  const current = (await page.evaluate(() => window.dreamEdge.workspace({ operation: 'current' }))).project;
  assert.equal(current.definition.dependencies.react, '19.2.0'); assert.equal(current.definition.dependencies['react-dom'], '19.2.0');
  assert.equal(Object.keys(current.definition.dependencyLock.packages).length, 3);
  const first = JSON.parse(await readFile(join(project.buildDirectory, (await readdir(project.buildDirectory)).find(name => !name.startsWith('.')), 'record.json'), 'utf8'));
  await application.evaluate(() => { globalThis.fetch = async () => { throw new Error('Locked cached rebuild must not use the registry'); }; });
  await panel.getByRole('button', { name: '构建候选', exact: true }).click();
  await panel.getByText('构建成功，请预览并确认保存。', { exact: true }).waitFor();
  const records = await Promise.all((await readdir(project.buildDirectory)).filter(name => !name.startsWith('.')).map(async name => JSON.parse(await readFile(join(project.buildDirectory, name, 'record.json'), 'utf8'))));
  assert.equal(records.length, 2); assert.deepEqual(records.find(record => record.id !== first.id).outputHashes, first.outputHashes);
  console.log('PASS: live npm React 19.2.0 + ReactDOM + scheduler install, TSX build, isolated browser preview, confirmed lock and identical offline cached rebuild.');
} catch (error) {
  if (project) {
    const names = await readdir(project.buildDirectory).catch(() => []);
    for (const name of names.filter(name => !name.startsWith('.'))) {
      const record = JSON.parse(await readFile(join(project.buildDirectory, name, 'record.json'), 'utf8'));
      console.error(JSON.stringify({ status: record.status, phase: record.phase, logs: record.logs }));
    }
  }
  throw error;
} finally {
  if (application) {
    const closed = await Promise.race([application.close().then(() => true).catch(() => true), new Promise(resolve => setTimeout(() => resolve(false), 5000))]);
    if (!closed) application.process().kill('SIGKILL');
  }
  await rm(profile, { recursive: true, force: true }); await rm(source, { recursive: true, force: true });
}
