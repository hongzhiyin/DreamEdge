import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';
import { lt } from 'semver';
import { appExecutable, replaceApp } from './export-acceptance.e2e.mjs';
import { upgradeModel } from './upgrade-model.e2e.mjs';

if (process.platform !== 'darwin') { console.log('SKIP: packaged framework upgrade requires macOS.'); process.exit(0); }
const before = process.env.DREAMEDGE_PREVIOUS_APP;
const after = process.env.DREAMEDGE_NEXT_APP || resolve(`release/${process.arch === 'arm64' ? 'mac-arm64' : 'mac'}/DreamEdge.app`);
if (!before) throw new Error('Set DREAMEDGE_PREVIOUS_APP to a previous packaged DreamEdge.app.');
const asar = createRequire(import.meta.url)('@electron/asar');
const descriptor = app => JSON.parse(asar.extractFile(join(app, 'Contents/Resources/app.asar'), 'dist/app.json'));
const previous = descriptor(before); const next = descriptor(after);
assert.equal(next.appId, previous.appId); assert.equal(next.id, previous.id);
assert.ok(lt(previous.version, next.version), 'The replacement must have a newer framework version.');
const root = await mkdtemp(join(tmpdir(), 'dreamedge-framework-upgrade-'));
const profile = join(root, 'profile'); const installed = join(root, 'Installed/DreamEdge.app');
const errors = []; let application;
async function launch(expected) {
  const env = { ...process.env, DREAMEDGE_DATA_DIR: profile };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'DREAMEDGE_AI_API_KEY', 'DREAMEDGE_AI_MODEL', 'DREAMEDGE_AI_BASE_URL']) delete env[key];
  application = await electron.launch({ executablePath: appExecutable(installed), args: [], cwd: '/', env });
  const page = await application.firstWindow(); page.setDefaultTimeout(20000); page.on('pageerror', error => errors.push(error.message));
  await page.frameLocator('iframe').getByText(expected, { exact: true }).waitFor(); return page;
}
const current = page => page.evaluate(() => window.dreamEdge.workspace({ operation: 'current' }));
const git = (page, projectId) => page.evaluate(projectId => window.dreamEdge.git({ operation: 'status', projectId }), projectId);
async function send(page, greeting) {
  await upgradeModel(application, greeting);
  const chat = page.getByRole('region', { name: 'AI 会话' });
  await chat.getByLabel('修改需求', { exact: true }).fill(`把问候语改为 ${greeting}`);
  await chat.getByRole('button', { name: '发送给 AI', exact: true }).click();
  await page.frameLocator('iframe').getByText(greeting, { exact: true }).waitFor();
  await chat.getByText('修改已应用，页面已自动刷新。', { exact: true }).last().waitFor();
}
try {
  await replaceApp(resolve(before), installed); let page = await launch('HelloWorld');
  assert.equal((await page.evaluate(() => window.dreamEdge.info())).version, previous.version);
  const project = await page.evaluate(directory => window.dreamEdge.workspace({ operation: 'create', directory, name: 'Upgrade project' }), join(root, 'project'));
  const projectId = project.definition.id;
  await page.evaluate(async projectId => {
    const state = await window.dreamEdge.modelSettings({ operation: 'get', projectId });
    await window.dreamEdge.modelSettings({ operation: 'save', projectId, expectedRevision: state.revision,
      apiKey: 'fixture-upgrade-key', model: 'fixture', baseUrl: 'https://model.example/v1' });
  }, projectId);
  await page.getByRole('button', { name: '打开开发侧栏' }).click();
  await send(page, 'Hello Framework v1');
  const session = (await page.evaluate(projectId => window.dreamEdge.development({ operation: 'list', projectId }), projectId))[0];
  assert.equal(session.turns.length, 1); assert.equal(session.turns[0].applied, true);
  let status = await git(page, projectId);
  await page.evaluate(({ projectId, stateHash }) => window.dreamEdge.git({ operation: 'commit', projectId, message: 'Before framework upgrade', expectedStateHash: stateHash }), { projectId, stateHash: status.stateHash });
  const committed = await git(page, projectId); assert.equal(committed.changed.length, 0);
  const tool = (await page.evaluate(() => window.dreamEdge.tools()))[0];
  await page.evaluate(tool => window.dreamEdge.storage(tool.id, { operation: 'put', collection: 'upgrade', id: 'record', value: { kept: true } }, tool.contextId), tool);
  const retained = {};
  for (const file of ['.dreamedge/project.json', '.dreamedge/model.json', 'src/main.ts', '.gitignore']) retained[file] = await readFile(join(project.rootDirectory, file), 'utf8');
  const beforeProfile = await application.evaluate(({ app }) => app.getPath('userData'));
  await application.close(); application = undefined;
  await replaceApp(resolve(after), installed); page = await launch('Hello Framework v1');
  const info = await page.evaluate(() => window.dreamEdge.info()); assert.equal(info.version, next.version);
  assert.equal(await application.evaluate(({ app }) => app.getPath('userData')), beforeProfile);
  const restored = (await current(page)).project; assert.deepEqual(restored.definition, JSON.parse(retained['.dreamedge/project.json']));
  assert.equal(restored.rootDirectory, project.rootDirectory);
  for (const [file, text] of Object.entries(retained)) assert.equal(await readFile(join(restored.rootDirectory, file), 'utf8'), text);
  const connection = await page.evaluate(projectId => window.dreamEdge.modelSettings({ operation: 'get', projectId }), projectId);
  assert.equal(connection.hasKey, true); assert.equal(connection.model, 'fixture'); assert.equal(connection.baseUrl, 'https://model.example/v1');
  assert.ok(!JSON.stringify(connection).includes('fixture-upgrade-key'));
  const history = await page.evaluate(({ projectId, sessionId }) => window.dreamEdge.development({ operation: 'get', projectId, sessionId }), { projectId, sessionId: session.id });
  assert.deepEqual(history, session);
  const savedCommits = commits => commits.map(({ id, message, createdAt }) => ({ id, message, createdAt }));
  assert.deepEqual(savedCommits((await git(page, projectId)).commits), savedCommits(committed.commits));
  const restoredTool = (await page.evaluate(() => window.dreamEdge.tools()))[0]; assert.equal(restoredTool.id, tool.id);
  assert.deepEqual(await page.evaluate(tool => window.dreamEdge.storage(tool.id, { operation: 'list', collection: 'upgrade' }, tool.contextId), restoredTool), [{ id: 'record', value: { kept: true } }]);
  await page.getByRole('button', { name: '打开开发侧栏' }).click();
  await page.getByText('已更新为 Hello Framework v1。', { exact: true }).waitFor();
  await send(page, 'Hello Framework v2');
  const continued = await page.evaluate(({ projectId, sessionId }) => window.dreamEdge.development({ operation: 'get', projectId, sessionId }), { projectId, sessionId: session.id });
  assert.equal(continued.turns.length, 2); assert.equal(continued.turns[1].applied, true);
  assert.equal((await git(page, projectId)).head, committed.head); assert.ok((await git(page, projectId)).changed.includes('src/main.ts'));
  await mkdir('artifacts', { recursive: true }); await page.screenshot({ path: 'artifacts/dreamedge-framework-upgrade.png' });
  await application.close(); application = undefined; page = await launch('Hello Framework v2');
  assert.equal((await current(page)).project.definition.id, projectId);
  assert.deepEqual(errors, []);
  console.log(`PASS: framework ${previous.version}→${next.version} replaced at the same installed path; project/source, model file/key, Git commits, completed AI session, business data, second-turn editing and restart retained.`);
} finally {
  if (application) await application.close().catch(() => application.process().kill('SIGKILL'));
  await rm(root, { recursive: true, force: true });
}
