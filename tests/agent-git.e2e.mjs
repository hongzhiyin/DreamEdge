import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { _electron as electron } from 'playwright';
import electronPath from 'electron';
import { agentGitProvider } from './agent-git-provider.e2e.mjs';
const root = await mkdtemp(join(tmpdir(), 'dreamedge-agent-git-ui-')); let application;
try {
  const env = { ...process.env, DREAMEDGE_DATA_DIR: join(root, 'profile') };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'DREAMEDGE_AI_API_KEY', 'DREAMEDGE_AI_MODEL', 'DREAMEDGE_AI_BASE_URL']) delete env[key];
  application = await electron.launch({ executablePath: process.env.DREAMEDGE_EXECUTABLE_PATH || electronPath, args: process.env.DREAMEDGE_EXECUTABLE_PATH ? [] : [resolve('.')], env });
  const page = await application.firstWindow(); page.setDefaultTimeout(20000); const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.frameLocator('iframe').getByText('HelloWorld', { exact: true }).waitFor(); await page.getByRole('button', { name: '打开开发侧栏' }).click();
  const directory = join(root, 'business'); await application.evaluate(({ dialog }, path) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: path }); }, directory);
  await page.getByRole('button', { name: /^新建工程/ }).click(); await page.getByText('business', { exact: true }).waitFor();
  const project = (await page.evaluate(() => window.dreamEdge.workspace({ operation: 'current' }))).project;
  await page.evaluate(async projectId => { const settings = await window.dreamEdge.modelSettings({ operation: 'get', projectId }); await window.dreamEdge.modelSettings({ operation: 'save', projectId,
    expectedRevision: settings.revision, apiKey: 'fixture-git-agent-key', model: 'fixture', baseUrl: 'https://model.example/v1' }); }, project.definition.id);
  const key = await readFile(join(directory, '.dreamedge/model.json'), 'utf8');
  const chat = page.getByRole('region', { name: 'AI 会话' });
  async function send(mode, prompt, greeting = '') {
    await agentGitProvider(application, mode, greeting);
    const count = await chat.locator('.chat-turn').count(); await chat.getByLabel('修改需求', { exact: true }).fill(prompt); await chat.getByRole('button', { name: '发送给 AI', exact: true }).click();
    const turn = chat.locator('.chat-turn').nth(count); await turn.waitFor();
    await page.waitForFunction(index => { const turns = document.querySelectorAll('.chat-turn'); return !!turns[index] && !turns[index].querySelector('.chat-progress'); }, count);
    assert.equal(await turn.getByRole('alert').count(), 0, await turn.textContent());
    return turn;
  }
  await send('edit', '把问候语改为 Hello Git A', 'Hello Git A'); await page.frameLocator('iframe').getByText('Hello Git A', { exact: true }).waitFor();
  await writeFile(join(directory, 'README.md'), 'Commit root document too');
  const commit = await send('commit', '提交当前修改'); await commit.getByText(/^已提交 Git：/).waitFor();
  const status = () => page.evaluate(projectId => window.dreamEdge.git({ operation: 'status', projectId }), project.definition.id);
  const saved = await status(); assert.equal(saved.changed.length, 0); assert.equal(saved.commits[0].message, 'AI milestone A');
  await send('edit', '把问候语改为 Hello Git B', 'Hello Git B'); await page.frameLocator('iframe').getByText('Hello Git B', { exact: true }).waitFor();
  const restore = await send('restore', '恢复刚才提交中的页面'); await page.frameLocator('iframe').getByText('Hello Git A', { exact: true }).waitFor();
  await restore.getByText(/^恢复前修改已备份到 Git：/).waitFor(); await restore.getByText(/提交历史保持不变/).waitFor();
  const restored = await status(); assert.notEqual(restored.head, saved.head); assert.ok(restored.commits.some(commit => commit.id === saved.head)); assert.ok(restored.changed.length);
  assert.equal(await readFile(join(directory, 'README.md'), 'utf8'), 'Commit root document too'); assert.equal(await readFile(join(directory, '.dreamedge/model.json'), 'utf8'), key);
  await restore.locator('.chat-process > summary').click();
  assert.deepEqual(await restore.locator('[data-event-kind=tool]').evaluateAll(nodes => nodes.map(node => node.querySelector('.timeline-label').textContent.split(' · ')[0])), ['查看 Git 历史', '查看 Git 差异', '准备历史恢复', '提交修改']);
  await restore.locator('.chat-process > summary').click();
  await chat.getByRole('log').evaluate(element => { element.scrollTop = element.scrollHeight; });
  await mkdir('artifacts', { recursive: true }); await page.screenshot({ path: 'artifacts/dreamedge-agent-git.png' });
  const readonly = await send('readonly', '查看历史和差异，不要提交，也不要恢复'); await readonly.getByText('已查阅 Git，未提交也未恢复。', { exact: true }).waitFor();
  assert.equal((await status()).head, restored.head); assert.deepEqual(errors, []);
  console.log('PASS: pi Git status/log/diff, explicit conversational whole-repository commit, restore with checkpoint/refresh, key retention, ordered tools and read-only negation.');
} finally { if (application) await application.close(); await rm(root, { recursive: true, force: true }); }
