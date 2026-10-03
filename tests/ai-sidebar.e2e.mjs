import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { _electron as electron } from 'playwright';
import electronPath from 'electron';

const profile = await mkdtemp(join(tmpdir(), 'dreamedge-ai-profile-'));
const source = await mkdtemp(join(tmpdir(), 'dreamedge-ai-source-'));
const key = 'fixture-ai-private-key'; let application; const errors = [];
async function launch(expected = 'HelloWorld') {
  const env = { ...process.env, DREAMEDGE_DATA_DIR: profile };
  for (const field of ['ELECTRON_RUN_AS_NODE', 'DREAMEDGE_AI_API_KEY', 'DREAMEDGE_AI_MODEL', 'DREAMEDGE_AI_BASE_URL']) delete env[field];
  application = await electron.launch({ executablePath: process.env.DREAMEDGE_EXECUTABLE_PATH || electronPath,
    args: process.env.DREAMEDGE_EXECUTABLE_PATH ? [] : [resolve('.')], env });
  const page = await application.firstWindow(); page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
  await page.frameLocator('iframe').getByText(expected, { exact: true }).waitFor(); return page;
}
async function mockModel() {
  await application.evaluate((_electron, key) => {
    globalThis.modelMode = 'success'; globalThis.modelRequests = [];
    const emit = output => {
      const items = output.map((item, index) => ({ ...item, id: item.id ?? `${item.type === 'function_call' ? 'fc' : 'msg'}_fixture_${index}` }));
      const events = [{ type: 'response.created', response: { id: 'resp_fixture', status: 'in_progress' } }];
      items.forEach((item, output_index) => {
        events.push({ type: 'response.output_item.added', output_index, item: { ...item, arguments: item.type === 'function_call' ? '' : undefined, content: item.type === 'message' ? [] : item.content } });
        events.push({ type: 'response.output_item.done', output_index, item });
      });
      events.push({ type: 'response.completed', response: { id: 'resp_fixture', status: 'completed', output: items } });
      return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } });
    };
    globalThis.fetch = async (url, options) => {
      if (String(url) !== 'https://api.deepseek.com/responses') throw new Error('Unexpected service URL');
      if (new Headers(options.headers).get('Authorization') !== `Bearer ${key}`) throw new Error('Missing model credential');
      const body = JSON.parse(options.body);
      if (JSON.stringify(body).includes(key) || body.store !== false || options.redirect !== 'error') throw new Error('Unsafe request');
      if (body.text?.format?.name === 'dreamedge_connection') return Response.json({ status: 'completed', output: [
        { type: 'message', content: [{ type: 'output_text', text: '{"ok":true}' }] }] });
      globalThis.modelRequests.push(body);
      if (globalThis.modelMode === 'pending') return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('Fixture cancelled')), { once: true }));
      if (globalThis.modelMode === 'httpError') return new Response(key, { status: 401 });
      const outputs = body.input.filter(item => item.type === 'function_call_output');
      const functionCalls = body.input.filter(item => item.type === 'function_call');
      const lastTool = functionCalls.at(-1)?.name;
      const next = outputs.length === 0 ? ['list_files', { directory: '', offset: 0 }]
        : lastTool === 'list_files' ? ['search_files', { directory: '', query: globalThis.nextGreeting === 'Hello Agent' ? 'Hello AI' : 'HelloWorld' }]
        : lastTool === 'search_files' ? ['read_file', { path: 'main.ts' }]
        : lastTool === 'read_file' && body.tools.some(tool => tool.name === 'git_commit') ? ['git_commit', { message: 'AI second edit' }] : null;
      if (next) return emit([{ type: 'function_call', call_id: `call_${globalThis.modelRequests.length}`, name: next[0], arguments: JSON.stringify(next[1]) }]);
      const greeting = globalThis.nextGreeting || 'Hello AI';
      const result = { summary: `已将问候语改为 ${greeting}。`, files: [{ path: 'main.ts', content: `document.getElementById('root')!.textContent = '${greeting}';\n` }] };
      if (greeting === 'Hello Agent' && !globalThis.malformedFinalSent) {
        globalThis.malformedFinalSent = true;
        return emit([{ type: 'message', content: [{ type: 'output_text', text: '说明：已完成。\n```json\n' + JSON.stringify(result) + '\n```' }] }]);
      }
      return emit([{ type: 'function_call', call_id: `proposal_${globalThis.modelRequests.length}`, name: 'propose_changes', arguments: JSON.stringify(result) }]);
    };
  }, key);
}
async function scanPlaintext(root) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) await scanPlaintext(path);
    else if (path !== join(source, 'AI HelloWorld', '.dreamedge/model.json') && /\.(json|ts|tsx|txt|html|log)$/.test(entry.name)) assert.ok(!(await readFile(path, 'utf8')).includes(key), `Credential leaked in ${entry.name}`);
  }
}
try {
  let page = await launch(); await mockModel();
  await page.getByRole('button', { name: '打开开发侧栏' }).click();
  await application.evaluate(({ dialog }, directory) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: directory }); }, join(source, 'AI HelloWorld'));
  await page.getByRole('button', { name: /^新建工程/ }).click();
  await page.getByText('AI HelloWorld', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('服务地址', { exact: true }).isVisible(), false);
  await page.getByRole('button', { name: '打开工程设置' }).click();
  await page.getByLabel('服务地址', { exact: true }).waitFor();
  await page.waitForFunction(() => !document.querySelector('.ai-form input[type=url]')?.disabled);
  const project = (await page.evaluate(() => window.dreamEdge.workspace({ operation: 'current' }))).project;
  await page.getByRole('button', { name: '使用 DeepSeek', exact: true }).click();
  assert.equal(await page.getByLabel('服务地址', { exact: true }).inputValue(), 'https://api.deepseek.com');
  assert.equal(await page.getByLabel('模型名称', { exact: true }).inputValue(), 'deepseek-flash');
  await page.getByLabel('API Key', { exact: true }).fill(key);
  await page.getByRole('button', { name: '保存配置', exact: true }).click();
  await page.getByText('模型配置已保存到当前工程。', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('API Key', { exact: true }).inputValue(), '');
  const state = await page.evaluate(projectId => window.dreamEdge.modelSettings({ operation: 'get', projectId }), project.definition.id);
  assert.equal(state.hasKey, true); assert.ok(!JSON.stringify(state).includes(key));
  assert.equal(JSON.parse(await readFile(join(project.rootDirectory, '.dreamedge/model.json'), 'utf8')).apiKey, key);
  await page.getByRole('button', { name: '测试连接', exact: true }).click();
  await page.getByText('连接测试成功，模型支持当前结构化响应。', { exact: true }).waitFor();
  const configPath = join(project.rootDirectory, '.dreamedge/model.json');
  const external = JSON.parse(await readFile(configPath, 'utf8')); external.model = 'deepseek-v4-pro';
  await (await import('node:fs/promises')).writeFile(configPath, JSON.stringify(external));
  await page.getByRole('button', { name: '重新读取文件', exact: true }).click();
  await page.getByText('已重新读取工程配置文件。', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('模型名称', { exact: true }).inputValue(), 'deepseek-v4-pro');
  await page.getByRole('button', { name: '返回 AI 对话' }).click();
  const chat = page.getByRole('region', { name: 'AI 会话' }); await chat.waitFor();
  const before = await readFile(join(project.sourceDirectory, 'main.ts'), 'utf8');
  await chat.getByLabel('修改需求', { exact: true }).fill('把 HelloWorld 改成 Hello AI');
  await chat.getByLabel('修改需求', { exact: true }).evaluate(element => element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true })));
  assert.equal(await application.evaluate(() => globalThis.modelRequests.length), 0);
  await chat.getByLabel('修改需求', { exact: true }).press('Enter');
  await chat.getByText('已将问候语改为 Hello AI。', { exact: true }).waitFor();
  await chat.getByRole('button', { name: '查看第 1 轮修改 · 1 个文件' }).click();
  const candidate = chat.getByRole('region', { name: '修改记录' }); await candidate.waitFor();
  await candidate.locator('.ai-file-change > summary').click();
  assert.match(await candidate.getByLabel('修改差异 main.ts', { exact: true }).textContent(), /HelloWorld/);
  assert.match(await candidate.getByLabel('修改差异 main.ts', { exact: true }).textContent(), /Hello AI/);
  assert.match(await readFile(join(project.sourceDirectory, 'main.ts'), 'utf8'), /Hello AI/);
  const request = await application.evaluate(() => globalThis.modelRequests[0]);
  assert.ok(!JSON.stringify(request.input).includes(before)); assert.ok(!JSON.stringify(request.input).includes(source));
  assert.equal(await chat.locator('input[type="checkbox"]').count(), 0);
  await chat.locator('.chat-process > summary').click();
  await chat.getByRole('list', { name: '执行过程' }).waitFor();
  assert.ok(await chat.locator('[data-event-kind=tool]').count() >= 4);
  const requests = await application.evaluate(() => globalThis.modelRequests);
  assert.equal(requests.length, 4); assert.ok(JSON.stringify(requests.at(-1).input).includes('main.ts'));
  assert.equal(await chat.getByRole('button', { name: '构建此候选', exact: true }).count(), 0);
  await page.frameLocator('iframe').getByText('Hello AI', { exact: true }).waitFor();
  const gitBar = chat.getByRole('region', { name: '工程 Git 状态' });
  await gitBar.getByRole('button', { name: '提交', exact: true }).click();
  await gitBar.getByText('工程修改已提交 Git。', { exact: true }).waitFor();
  await page.getByRole('button', { name: '打开工程设置' }).click();
  await page.getByRole('tab', { name: 'Git 历史', exact: true }).click();
  assert.equal(await page.getByLabel('本轮完成后提交工程修改到 Git', { exact: true }).count(), 0);
  await page.getByRole('button', { name: '返回 AI 对话' }).click();
  await application.evaluate(() => { globalThis.nextGreeting = 'Hello Agent'; });
  await chat.getByLabel('修改需求', { exact: true }).fill('先查看工程，把问候语改成 Hello Agent');
  await chat.getByRole('button', { name: '发送给 AI', exact: true }).click();
  await chat.getByText('已将问候语改为 Hello Agent。', { exact: true }).waitFor();
  await chat.getByRole('button', { name: '查看第 2 轮修改 · 1 个文件' }).click();
  const second = chat.getByRole('region', { name: '修改记录' });
  await second.locator('.ai-file-change > summary').click();
  assert.match(await second.getByLabel('修改差异 main.ts', { exact: true }).textContent(), /Hello AI/);
  await page.frameLocator('iframe').getByText('Hello Agent', { exact: true }).waitFor();
  assert.equal(await chat.getByText(/^已提交 Git：/).count(), 0);
  await gitBar.getByRole('button', { name: '提交', exact: true }).click();
  await gitBar.getByText('无未提交工程修改', { exact: true }).waitFor();
  await chat.getByRole('button', { name: '查看第 2 轮修改 · 1 个文件' }).click();
  await mkdir('artifacts', { recursive: true });
  await page.screenshot({ path: 'artifacts/dreamedge-ai-conversation.png' });
  await page.getByRole('button', { name: '打开工程设置' }).click();
  await page.getByRole('tab', { name: '工程管理' }).click();
  const nextWindow = application.waitForEvent('window'); await page.getByRole('button', { name: /^新窗口/ }).click();
  const blank = await nextWindow; await blank.frameLocator('iframe').getByText('HelloWorld', { exact: true }).waitFor();
  assert.equal(await blank.locator('.settings-section').count(), 0);
  await assert.rejects(blank.evaluate(projectId => window.dreamEdge.modelSettings({ operation: 'get', projectId }), project.definition.id), /当前工程/);
  const noProject = await blank.evaluate(() => window.dreamEdge.windows({ operation: 'current' })); assert.equal(noProject.project, null);
  await assert.rejects(blank.evaluate(({ id, projectId }) => window.dreamEdge.development({ operation: 'get', projectId, sessionId: id }),
    { projectId: project.definition.id, id: (await page.evaluate(id => window.dreamEdge.development({ operation: 'listSummaries', projectId: id }), project.definition.id))[0].id }), /当前工程/);
  await page.getByRole('button', { name: '返回 AI 对话' }).click();
  const beforePending = await application.evaluate(() => globalThis.modelRequests.length);
  await application.evaluate(() => { globalThis.modelMode = 'pending'; });
  await chat.getByLabel('修改需求', { exact: true }).fill('继续修改'); await chat.getByRole('button', { name: '发送给 AI', exact: true }).click();
  await chat.getByRole('button', { name: '取消请求', exact: true }).waitFor();
  await page.getByRole('button', { name: '打开工程设置' }).click();
  await page.getByRole('button', { name: '返回 AI 对话' }).click();
  await chat.getByRole('button', { name: '取消请求', exact: true }).click(); await chat.getByText('请求已取消；源码未被修改。', { exact: true }).waitFor();
  assert.equal((await application.evaluate(() => globalThis.modelRequests.length)), beforePending + 1);
  const continuation = await application.evaluate(() => globalThis.modelRequests.at(-1).input); assert.ok(JSON.stringify(continuation).includes('Hello Agent'));
  await application.evaluate(() => { globalThis.modelMode = 'httpError'; });
  await chat.getByLabel('修改需求', { exact: true }).fill('再试一次'); await chat.getByRole('button', { name: '发送给 AI', exact: true }).click();
  await chat.getByRole('alert').filter({ hasText: 'HTTP 401' }).waitFor();
  assert.ok(!(await chat.textContent()).includes(key));
  await scanPlaintext(profile); await scanPlaintext(source);
  await application.close(); page = await launch('Hello Agent');
  await page.frameLocator('iframe').getByText('Hello Agent', { exact: true }).waitFor();
  const restored = await page.evaluate(projectId => window.dreamEdge.modelSettings({ operation: 'get', projectId }), project.definition.id); assert.equal(restored.hasKey, true);
  const histories = await page.evaluate(id => window.dreamEdge.development({ operation: 'listSummaries', projectId: id }), project.definition.id);
  assert.equal(histories[0].turnCount, 4); assert.deepEqual(errors, []);
  console.log('PASS: model configuration/probe, scoped AI conversation, captured diff, automatic build/apply/refresh, separate settings and Git history, cancellation, redacted errors and restart recovery.');
} finally {
  if (application) {
    const closed = await Promise.race([application.close().then(() => true).catch(() => true), new Promise(resolve => setTimeout(() => resolve(false), 5000))]);
    if (!closed) application.process().kill('SIGKILL');
  }
  await rm(profile, { recursive: true, force: true }); await rm(source, { recursive: true, force: true });
}
