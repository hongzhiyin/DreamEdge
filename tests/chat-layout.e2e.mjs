import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { _electron as electron } from 'playwright';
import electronPath from 'electron';
import { SessionStore } from '../desktop/development/sessions.ts';

const profile = await mkdtemp(join(tmpdir(), 'dreamedge-chat-layout-profile-'));
const source = await mkdtemp(join(tmpdir(), 'dreamedge-chat-layout-source-'));
let application;
try {
  const env = { ...process.env, DREAMEDGE_DATA_DIR: profile };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'DREAMEDGE_AI_API_KEY', 'DREAMEDGE_AI_MODEL', 'DREAMEDGE_AI_BASE_URL']) delete env[key];
  application = await electron.launch({ executablePath: process.env.DREAMEDGE_EXECUTABLE_PATH || electronPath,
    args: process.env.DREAMEDGE_EXECUTABLE_PATH ? [] : [resolve('.')], env });
  const page = await application.firstWindow(); page.setDefaultTimeout(15000); const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.frameLocator('iframe').getByText('HelloWorld', { exact: true }).waitFor();
  await page.getByRole('button', { name: '打开开发侧栏' }).click();
  await application.evaluate(({ dialog }, directory) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: directory }); }, join(source, '聊天布局验收'));
  await page.getByRole('button', { name: /^新建工程/ }).click();
  await page.getByText('聊天布局验收', { exact: true }).waitFor();
  const project = (await page.evaluate(() => window.dreamEdge.workspace({ operation: 'current' }))).project;
  const store = new SessionStore(); const session = await store.create(project, '长会话排版验收');
  session.turns = Array.from({ length: 12 }, (_, index) => ({ id: randomUUID(), prompt: `第 ${index + 1} 次请求：请修改页面上的问候语，并保持页面布局清晰。`,
    startedAt: session.createdAt, finishedAt: session.createdAt, status: 'completed', phase: 'complete',
    summary: `第 ${index + 1} 次回复：已经查看工程并完成页面修改。\n应用会自动构建并刷新，接下来可以继续描述需要的效果。`,
    context: [], changes: [], applied: true, error: null,
    activity: [{ id: `activity-${index}`, tool: 'read_file', detail: 'main.ts', status: 'completed' }] }));
  await store.save(project, session);
  await page.reload(); await page.getByRole('button', { name: '打开开发侧栏' }).click();
  const chat = page.getByRole('region', { name: 'AI 会话' }); const log = chat.getByRole('log');
  await chat.getByText('第 12 次回复：', { exact: false }).waitFor();
  await page.waitForFunction(() => { const log = document.querySelector('.chat-thread'); return log.scrollTop > 100; });
  const input = chat.getByLabel('修改需求', { exact: true });
  await input.fill('保留这份草稿'); await input.press('Shift+Enter'); await input.press('End'); await input.type('下一行');
  assert.equal(await input.inputValue(), '保留这份草稿\n下一行');
  await page.getByRole('button', { name: '打开工程设置' }).click();
  assert.equal(await chat.isVisible(), false);
  await page.getByRole('region', { name: '模型连接', exact: true }).waitFor();
  await page.getByLabel('模型名称', { exact: true }).fill('未保存的模型草稿');
  await page.getByRole('button', { name: '返回 AI 对话' }).click();
  assert.equal(await input.inputValue(), '保留这份草稿\n下一行');
  await page.getByRole('button', { name: '收起开发侧栏' }).click();
  await page.getByRole('button', { name: '打开开发侧栏' }).click();
  assert.equal(await input.inputValue(), '保留这份草稿\n下一行');
  await page.getByRole('button', { name: '打开工程设置' }).click();
  assert.equal(await page.getByLabel('模型名称', { exact: true }).inputValue(), '未保存的模型草稿');
  const modelTab = page.getByRole('tab', { name: '模型连接', exact: true });
  const settingsWindow = await application.browserWindow(page); await settingsWindow.evaluate(window => window.focus());
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => resolve())));
  await modelTab.focus(); await modelTab.press('ArrowRight');
  await page.waitForFunction(() => document.getElementById('settings-tab-1')?.getAttribute('aria-selected') === 'true');
  assert.equal(await page.getByRole('tab', { name: 'Git 历史', exact: true }).getAttribute('aria-selected'), 'true');
  assert.equal(await page.getByLabel('服务地址', { exact: true }).isVisible(), false);
  await page.getByRole('button', { name: '返回 AI 对话' }).click();
  const composer = chat.locator('.chat-composer'); const before = await composer.boundingBox();
  await log.evaluate(element => { element.scrollTop = 120; });
  await chat.getByRole('button', { name: '回到最新消息' }).waitFor();
  const after = await composer.boundingBox(); assert.equal(before.y, after.y);
  await page.getByRole('button', { name: '打开工程设置' }).click();
  await page.getByRole('button', { name: '返回 AI 对话' }).click();
  assert.equal(await log.evaluate(element => element.scrollTop), 120);
  await chat.getByRole('button', { name: '回到最新消息' }).click();
  await page.waitForFunction(() => { const log = document.querySelector('.chat-thread'); return log.scrollHeight - log.clientHeight - log.scrollTop < 2; });
  assert.equal(await log.locator('details[open]').count(), 0);
  const original = await input.inputValue();
  await input.fill(Array.from({ length: 12 }, (_, index) => `长草稿第 ${index + 1} 行`).join('\n'));
  await page.waitForFunction(() => { const log = document.querySelector('.chat-thread'); return log.scrollHeight - log.clientHeight - log.scrollTop < 2; });
  assert.equal(await input.evaluate(element => element.getBoundingClientRect().height), 144);
  await input.fill(original);
  await input.evaluate(element => element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true })));
  assert.equal(await input.inputValue(), original);
  assert.equal((await page.evaluate(id => window.dreamEdge.development({ operation: 'get', projectId: id, sessionId: document.querySelector('.session-picker select').value }), project.definition.id)).turns.length, 12);
  await mkdir('artifacts', { recursive: true });
  await page.screenshot({ path: 'artifacts/dreamedge-chat-layout.png' });
  await page.getByRole('button', { name: '打开工程设置' }).click();
  await modelTab.click(); await page.screenshot({ path: 'artifacts/dreamedge-settings-layout.png' });
  const native = await application.browserWindow(page); await native.evaluate(window => window.setSize(640, 480));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.equal(await page.locator('.settings-content').evaluate(element => element.scrollHeight > element.clientHeight), true);
  await page.getByRole('button', { name: '返回 AI 对话' }).click();
  const small = await composer.boundingBox();
  assert.ok(small.y >= 0 && small.y + small.height <= await page.evaluate(() => innerHeight));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: 'artifacts/dreamedge-chat-small.png' });
  await chat.getByRole('button', { name: '配置模型连接，开始对话' }).click();
  assert.equal(await modelTab.getAttribute('aria-selected'), 'true');
  assert.deepEqual(errors, []);
  console.log('PASS: chat-first layout, fixed composer, retained drafts/scroll, collapsed activity, settings tabs, IME Enter and small-window layout.');
} finally {
  if (application) {
    const closed = await Promise.race([application.close().then(() => true).catch(() => true), new Promise(resolve => setTimeout(() => resolve(false), 5000))]);
    if (!closed) application.process().kill('SIGKILL');
  }
  await rm(profile, { recursive: true, force: true }); await rm(source, { recursive: true, force: true });
}
