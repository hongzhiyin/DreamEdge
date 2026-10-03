import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron } from 'playwright';
import electronPath from 'electron';
import { timelineProvider } from './timeline-provider.e2e.mjs';

const profile = await mkdtemp(join(tmpdir(), 'dreamedge-timeline-profile-'));
const source = await mkdtemp(join(tmpdir(), 'dreamedge-timeline-source-'));
let application;
async function launch(expected) {
  const env = { ...process.env, DREAMEDGE_DATA_DIR: profile };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'DREAMEDGE_AI_API_KEY', 'DREAMEDGE_AI_MODEL', 'DREAMEDGE_AI_BASE_URL']) delete env[key];
  application = await electron.launch({ executablePath: process.env.DREAMEDGE_EXECUTABLE_PATH || electronPath,
    args: process.env.DREAMEDGE_EXECUTABLE_PATH ? [] : [resolve('.')], env });
  const page = await application.firstWindow(); page.setDefaultTimeout(15000);
  await page.frameLocator('iframe').getByText(expected, { exact: true }).waitFor(); return page;
}
try {
  let page = await launch('HelloWorld'); const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.getByRole('button', { name: '打开开发侧栏' }).click();
  await application.evaluate(({ dialog }, path) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: path }); }, join(source, '执行过程验收'));
  await page.getByRole('button', { name: /^新建工程/ }).click(); await page.getByText('执行过程验收', { exact: true }).waitFor();
  const project = (await page.evaluate(() => window.dreamEdge.workspace({ operation: 'current' }))).project;
  await page.evaluate(async projectId => {
    const settings = await window.dreamEdge.modelSettings({ operation: 'get', projectId });
    await window.dreamEdge.modelSettings({ operation: 'save', projectId, expectedRevision: settings.revision,
      apiKey: 'fixture-timeline-key', model: 'test', baseUrl: 'https://model.example/v1' });
  }, project.definition.id);
  await timelineProvider(application);
  const chat = page.getByRole('region', { name: 'AI 会话' });
  await chat.getByLabel('修改需求', { exact: true }).fill('查看工程并修改问候语');
  await chat.getByRole('button', { name: '发送给 AI', exact: true }).click();
  await chat.getByLabel('生成回复 · 进行中', { exact: true }).waitFor();
  const thought = chat.locator('[data-event-kind=thinking]'); await thought.waitFor();
  assert.equal(await thought.locator('details').getAttribute('open'), null);
  await thought.locator('summary').click(); await thought.getByText('先查询依赖信息，再读取当前页面并修改问候语。', { exact: true }).waitFor();
  assert.equal(await chat.getByText('修改已应用，页面已自动刷新。', { exact: true }).count(), 0);
  assert.ok(!(await chat.textContent()).includes('opaque-not-visible'));
  await application.evaluate(() => globalThis.releaseReply());
  const lookup = chat.locator('[data-event-kind=tool]').filter({ hasText: '查询依赖' });
  await chat.getByLabel('查询依赖 · dreamedge-timeline · 进行中', { exact: true }).waitFor();
  await lookup.locator('summary').click(); assert.match(await lookup.textContent(), /"range": "\*"/);
  await application.evaluate(() => globalThis.releaseLookup());
  await chat.getByLabel('查询依赖 · dreamedge-timeline · 完成', { exact: true }).waitFor();
  assert.notEqual(await lookup.locator('details').getAttribute('open'), null); assert.match(await lookup.textContent(), /1\.0\.0/);
  await page.frameLocator('iframe').getByText('Hello Timeline', { exact: true }).waitFor();
  await chat.getByText('修改已应用，页面已自动刷新。', { exact: true }).waitFor();
  const calls = await chat.locator('[data-event-kind=tool] .timeline-label').allTextContents();
  assert.deepEqual(calls.map(text => text.split(' · ')[0]), ['查询依赖', '读取文件', '提交修改']);
  await chat.getByLabel('构建工程', { exact: false }).first().waitFor(); await chat.getByLabel('应用修改并刷新 · 完成', { exact: true }).waitFor();
  await lookup.locator('summary').click(); await thought.locator('summary').click();
  await mkdir('artifacts', { recursive: true }); await page.screenshot({ path: 'artifacts/dreamedge-agent-timeline.png' });
  await application.close(); page = await launch('Hello Timeline');
  await page.getByRole('button', { name: '打开开发侧栏' }).click();
  await page.locator('[data-event-kind=thinking]').waitFor();
  assert.equal(await page.locator('.chat-timeline details[open]').count(), 0);
  await page.locator('[data-event-kind=thinking] summary').click();
  await page.getByText('先查询依赖信息，再读取当前页面并修改问候语。', { exact: true }).waitFor();
  assert.deepEqual(errors, []);
  console.log('PASS: thinking before response EOF, ordered live tools, expandable parameters/results, build/apply status and restart persistence.');
} finally {
  if (application) {
    const closed = await Promise.race([application.close().then(() => true).catch(() => true), new Promise(resolve => setTimeout(() => resolve(false), 5000))]);
    if (!closed) application.process().kill('SIGKILL');
  }
  await rm(profile, { recursive: true, force: true }); await rm(source, { recursive: true, force: true });
}
