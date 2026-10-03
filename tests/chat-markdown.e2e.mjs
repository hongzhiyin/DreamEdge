import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { _electron as electron } from 'playwright';
import electronPath from 'electron';
import { SessionStore } from '../desktop/development/sessions.ts';

const profile = await mkdtemp(join(tmpdir(), 'dreamedge-markdown-profile-'));
const source = await mkdtemp(join(tmpdir(), 'dreamedge-markdown-source-'));
const markdown = ['## 修改完成', '', '**加粗**、*斜体*、~~旧内容~~与 `main.ts`。', '',
  '- 第一项', '- 第二项', '', '1. 检查页面', '2. 继续开发', '', '> 引用说明', '',
  '```ts', `const message = '${'long-code-'.repeat(35)}';`, '```', '',
  '| 文件 | 状态 |', '| --- | --- |', '| main.ts | 已更新 |', '', '- [x] 已构建', '',
  '[文档](https://example.com/docs)', '[危险](javascript:alert(1))', '',
  '<script>globalThis.markdownExecuted = true</script>', '', '![示意图](https://example.com/tracker.png)'].join('\n');
let application;
try {
  const env = { ...process.env, DREAMEDGE_DATA_DIR: profile };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'DREAMEDGE_AI_API_KEY', 'DREAMEDGE_AI_MODEL', 'DREAMEDGE_AI_BASE_URL']) delete env[key];
  application = await electron.launch({ executablePath: process.env.DREAMEDGE_EXECUTABLE_PATH || electronPath,
    args: process.env.DREAMEDGE_EXECUTABLE_PATH ? [] : [resolve('.')], env });
  const page = await application.firstWindow(); page.setDefaultTimeout(15000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.frameLocator('iframe').getByText('HelloWorld', { exact: true }).waitFor();
  await page.getByRole('button', { name: '打开开发侧栏' }).click();
  await application.evaluate(({ dialog }, directory) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: directory }); }, join(source, 'Markdown 验收'));
  await page.getByRole('button', { name: /^新建工程/ }).click();
  await page.getByText('Markdown 验收', { exact: true }).waitFor();
  const project = (await page.evaluate(() => window.dreamEdge.workspace({ operation: 'current' }))).project;
  const store = new SessionStore(); const session = await store.create(project, 'Markdown 与过程折叠');
  session.turns = ['completed', 'failed', 'cancelled'].map((status, index) => ({ id: randomUUID(),
    prompt: `**请求 ${index + 1}**：修改 \`main.ts\``, startedAt: session.createdAt, finishedAt: session.createdAt,
    status, phase: status === 'completed' ? 'complete' : 'thinking', summary: status === 'completed' ? markdown : null,
    context: [], changes: [], applied: false, error: status === 'failed' ? '测试失败信息' : null,
    events: [{ id: 'thought', kind: 'thinking', label: '思考摘要', status: 'completed', content: '**检查工程**\n\n- 先读取源码' },
      { id: 'read', kind: 'tool', label: '读取文件', status: 'completed', input: '{"path":"main.ts"}', output: '<script>原始源码保持文本</script>' }] }));
  await store.save(project, session);
  await page.reload(); await page.getByRole('button', { name: '打开开发侧栏' }).click();
  const chat = page.getByRole('region', { name: 'AI 会话' });
  const turn = chat.locator('.chat-turn').first(); const reply = turn.locator('.chat-reply');
  await reply.getByRole('heading', { name: '修改完成' }).waitFor();
  assert.equal(await turn.locator('.user-message strong').textContent(), '请求 1');
  for (const selector of ['strong', 'em', 'del', 'code', 'ul', 'ol', 'blockquote', 'pre code', 'table']) assert.ok(await reply.locator(selector).count() > 0, selector);
  assert.equal(await reply.locator('input[type=checkbox]').isChecked(), true);
  assert.equal(await reply.locator('input[type=checkbox]').isDisabled(), true);
  assert.equal(await reply.getByRole('link', { name: '文档' }).getAttribute('href'), 'https://example.com/docs');
  assert.equal(await reply.getByText('危险', { exact: true }).getAttribute('href'), '');
  assert.equal(await reply.locator('script, img').count(), 0);
  assert.equal(await page.evaluate(() => globalThis.markdownExecuted), undefined);
  const processPanel = turn.locator('.chat-process');
  assert.equal(await processPanel.getAttribute('open'), null);
  assert.equal(await processPanel.locator('.chat-timeline').isVisible(), false);
  await processPanel.locator(':scope > summary').click();
  await processPanel.locator('[data-event-kind=thinking] > details > summary').click();
  assert.equal(await processPanel.locator('.timeline-content strong').textContent(), '检查工程');
  await page.getByRole('button', { name: '打开工程设置' }).click();
  await page.getByRole('button', { name: '返回 AI 对话' }).click();
  assert.notEqual(await processPanel.getAttribute('open'), null);
  await processPanel.locator(':scope > summary').click();
  assert.equal(await reply.isVisible(), true);
  assert.equal(await chat.locator('.chat-turn').nth(1).locator('.chat-process').getAttribute('open'), '');
  assert.equal(await chat.locator('.chat-turn').nth(2).locator('.chat-process').getAttribute('open'), '');
  await chat.getByRole('alert').filter({ hasText: '测试失败信息' }).waitFor();
  const native = await application.browserWindow(page); await native.evaluate(window => window.setSize(640, 720));
  assert.equal(await reply.locator('pre').evaluate(element => element.scrollWidth > element.clientWidth), true);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await turn.scrollIntoViewIfNeeded();
  await mkdir('artifacts', { recursive: true }); await page.screenshot({ path: 'artifacts/dreamedge-chat-markdown.png' });
  await page.reload(); await page.getByRole('button', { name: '打开开发侧栏' }).click();
  await page.getByRole('heading', { name: '修改完成' }).waitFor();
  assert.equal(await page.locator('.chat-process').first().getAttribute('open'), null);
  assert.deepEqual(errors, []);
  console.log('PASS: user/reply/thought Markdown, GFM, inert HTML/URLs/images, collapse and reopen, failed/cancelled details, narrow layout and persisted history.');
} finally {
  if (application) await application.close();
  await rm(profile, { recursive: true, force: true }); await rm(source, { recursive: true, force: true });
}
