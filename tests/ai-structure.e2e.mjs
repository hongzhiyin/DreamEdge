import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron } from 'playwright';
import electronPath from 'electron';
import { packageRegistry } from './dependency-fixture.ts';
import { installStructureModel } from './ai-structure-provider.e2e.mjs';

const profile = await mkdtemp(join(tmpdir(), 'dreamedge-structure-profile-'));
const source = await mkdtemp(join(tmpdir(), 'dreamedge-structure-source-'));
let application;
try {
  const fixture = await packageRegistry();
  const item = await fixture.add('dreamedge-greeting', '1.0.0', { 'index.js': "export const greeting='Hello Structure';" });
  const upgraded = await fixture.add('dreamedge-greeting', '2.0.0', { 'index.js': "export const greeting='Hello Upgraded Dependency';" });
  const env = { ...process.env, DREAMEDGE_DATA_DIR: profile };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'DREAMEDGE_AI_API_KEY', 'DREAMEDGE_AI_MODEL', 'DREAMEDGE_AI_BASE_URL']) delete env[key];
  application = await electron.launch({ executablePath: process.env.DREAMEDGE_EXECUTABLE_PATH || electronPath,
    args: process.env.DREAMEDGE_EXECUTABLE_PATH ? [] : [resolve('.')], env });
  const page = await application.firstWindow(); page.setDefaultTimeout(20000); const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.frameLocator('iframe').getByText('HelloWorld', { exact: true }).waitFor();
  await page.getByRole('button', { name: '打开开发侧栏' }).click();
  await application.evaluate(({ dialog }, path) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: path }); }, join(source, 'AI 工程结构'));
  await page.getByRole('button', { name: /^新建工程/ }).click(); await page.getByText('AI 工程结构', { exact: true }).waitFor();
  const project = (await page.evaluate(() => window.dreamEdge.workspace({ operation: 'current' }))).project;
  await page.evaluate(async projectId => {
    await window.dreamEdge.workspace({ operation: 'writeFile', projectId, path: 'unused.ts', content: "export const unused='old';", expectedHash: null });
    const status = await window.dreamEdge.git({ operation: 'status', projectId });
    await window.dreamEdge.git({ operation: 'commit', projectId, message: 'Before AI structure', expectedStateHash: status.stateHash });
  }, project.definition.id);
  const baseline = (await page.evaluate(id => window.dreamEdge.git({ operation: 'status', projectId: id }), project.definition.id)).commits[0].id;
  await installStructureModel(application, [item, upgraded].map(item => ({ item, bytes: fixture.archives.get(item.tarball).toString('base64') })));
  await page.getByRole('button', { name: '打开工程设置' }).click(); await page.getByRole('button', { name: '使用 DeepSeek', exact: true }).click();
  await page.getByLabel('API Key', { exact: true }).fill('fixture-structure-key'); await page.getByRole('button', { name: '保存配置', exact: true }).click();
  await page.getByText('模型配置已保存到当前工程。', { exact: true }).waitFor(); await page.getByRole('button', { name: '返回 AI 对话' }).click();
  const chat = page.getByRole('region', { name: 'AI 会话' }); const input = chat.getByLabel('修改需求', { exact: true });
  await input.fill('使用 dreamedge-greeting，并删除 unused.ts'); await chat.getByRole('button', { name: '发送给 AI', exact: true }).click();
  await chat.getByText('修改已应用，页面已自动刷新。', { exact: true }).waitFor();
  await page.frameLocator('iframe').getByText('Hello Structure', { exact: true }).waitFor(); await assert.rejects(access(join(project.sourceDirectory, 'unused.ts')));
  assert.equal(JSON.parse(await readFile(join(project.rootDirectory, '.dreamedge/project.json'), 'utf8')).dependencies[item.name], item.version);
  await chat.getByRole('button', { name: '查看第 1 轮修改 · 2 个文件 · 依赖变更' }).click();
  const record = chat.getByRole('region', { name: '修改记录' });
  await record.locator('.ai-file-change > summary').filter({ hasText: 'unused.ts' }).click();
  assert.match(await record.getByLabel('修改差异 unused.ts').textContent(), /unused/);
  await record.locator('.ai-file-change > summary').filter({ hasText: '工程依赖' }).click();
  assert.match(await record.getByLabel('依赖声明差异').textContent(), /dreamedge-greeting/);
  await mkdir('artifacts', { recursive: true }); await page.screenshot({ path: 'artifacts/dreamedge-ai-structure.png' });
  const previousSource = await readFile(join(project.sourceDirectory, 'main.ts'), 'utf8');
  await application.evaluate(() => { globalThis.structureMode = 'upgrade'; });
  await input.fill('升级 dreamedge-greeting 到 2.0.0，保持源码不变'); await chat.getByRole('button', { name: '发送给 AI', exact: true }).click();
  await chat.locator('.chat-turn').last().getByText('修改已应用，页面已自动刷新。', { exact: true }).waitFor();
  await page.frameLocator('iframe').getByText('Hello Upgraded Dependency', { exact: true }).waitFor();
  assert.equal(await readFile(join(project.sourceDirectory, 'main.ts'), 'utf8'), previousSource);
  assert.equal(JSON.parse(await readFile(join(project.rootDirectory, '.dreamedge/project.json'), 'utf8')).dependencies[item.name], upgraded.version);
  await application.evaluate(() => { globalThis.structureMode = 'remove-only'; });
  await input.fill('只移除依赖，保留仍引用依赖的源码'); await chat.getByRole('button', { name: '发送给 AI', exact: true }).click();
  await chat.getByRole('alert').waitFor();
  await page.frameLocator('iframe').getByText('Hello Upgraded Dependency', { exact: true }).waitFor();
  assert.equal(JSON.parse(await readFile(join(project.rootDirectory, '.dreamedge/project.json'), 'utf8')).dependencies[item.name], upgraded.version);
  await application.evaluate(() => { globalThis.structureMode = 'remove'; });
  await input.fill('改用普通文本页面并移除依赖'); await chat.getByRole('button', { name: '发送给 AI', exact: true }).click();
  await chat.locator('.chat-turn').last().getByText('修改已应用，页面已自动刷新。', { exact: true }).waitFor();
  await page.frameLocator('iframe').getByText('Hello Without Dependencies', { exact: true }).waitFor();
  assert.deepEqual(JSON.parse(await readFile(join(project.rootDirectory, '.dreamedge/project.json'), 'utf8')).dependencies, {});
  const gitBar = chat.getByRole('region', { name: '工程 Git 状态' });
  await gitBar.getByRole('button', { name: '提交', exact: true }).click();
  await gitBar.getByText('工程修改已提交 Git。', { exact: true }).waitFor();
  await page.getByRole('button', { name: '打开工程设置' }).click(); await page.getByRole('tab', { name: 'Git 历史', exact: true }).click();
  const history = page.getByRole('region', { name: 'Git 历史', exact: true });
  await history.locator('.git-history li').filter({ hasText: baseline.slice(0, 8) }).getByRole('button', { name: '恢复此提交内容' }).click();
  await page.frameLocator('iframe').getByText('HelloWorld', { exact: true }).waitFor();
  assert.match(await readFile(join(project.sourceDirectory, 'unused.ts'), 'utf8'), /old/);
  assert.equal(JSON.parse(await readFile(join(project.rootDirectory, '.dreamedge/model.json'), 'utf8')).apiKey, 'fixture-structure-key');
  await page.getByRole('button', { name: '返回 AI 对话' }).click();
  const session = await page.evaluate(id => window.dreamEdge.development({ operation: 'listSummaries', projectId: id }), project.definition.id);
  assert.equal(session[0].turnCount, 4); assert.deepEqual(errors, []);
  console.log('PASS: native AI dependency lookup/declaration + deletion, automatic build/refresh, diffs, dependency-only upgrade/refresh, failed removal rollback, valid removal and Git restore.');
} catch (error) {
  if (application) {
    const page = application.windows()[0];
    await mkdir('artifacts', { recursive: true });
    await page?.screenshot({ path: 'artifacts/dreamedge-ai-structure-failure.png' }).catch(() => {});
    console.error(await page?.locator('.chat-thread').textContent().catch(() => 'Cannot read test conversation'));
  }
  throw error;
} finally {
  if (application) {
    const closed = await Promise.race([application.close().then(() => true).catch(() => true), new Promise(resolve => setTimeout(() => resolve(false), 5000))]);
    if (!closed) application.process().kill('SIGKILL');
  }
  await rm(profile, { recursive: true, force: true }); await rm(source, { recursive: true, force: true });
}
