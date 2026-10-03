import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { _electron as electron } from 'playwright';
import electronPath from 'electron';
const root = await mkdtemp(join(tmpdir(), 'dreamedge-root-ai-ui-')); let application;
try {
  const env = { ...process.env, DREAMEDGE_DATA_DIR: join(root, 'profile') };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'DREAMEDGE_AI_API_KEY', 'DREAMEDGE_AI_MODEL', 'DREAMEDGE_AI_BASE_URL']) delete env[key];
  application = await electron.launch({ executablePath: process.env.DREAMEDGE_EXECUTABLE_PATH || electronPath,
    args: process.env.DREAMEDGE_EXECUTABLE_PATH ? [] : [resolve('.')], env });
  const page = await application.firstWindow(); page.setDefaultTimeout(20000); const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.frameLocator('iframe').getByText('HelloWorld', { exact: true }).waitFor();
  await page.getByRole('button', { name: '打开开发侧栏' }).click();
  const directory = join(root, 'root-scope');
  await application.evaluate(({ dialog }, path) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: path }); }, directory);
  await page.getByRole('button', { name: /^新建工程/ }).click(); await page.getByText('root-scope', { exact: true }).waitFor();
  const project = (await page.evaluate(() => window.dreamEdge.workspace({ operation: 'current' }))).project;
  await writeFile(join(directory, 'README.md'), '# Existing project');
  await page.evaluate(async projectId => {
    const settings = await window.dreamEdge.modelSettings({ operation: 'get', projectId });
    await window.dreamEdge.modelSettings({ operation: 'save', projectId, expectedRevision: settings.revision,
      apiKey: 'fixture-root-key', model: 'fixture-root', baseUrl: 'https://model.example/v1' });
  }, project.definition.id);
  const keyFile = await readFile(join(directory, '.dreamedge/model.json'), 'utf8');
  await application.evaluate(() => {
    let request = 0;
    globalThis.fetch = async (_url, options) => {
      const body = JSON.parse(options.body); assertRoot(body);
      const last = body.input?.filter(item => item.type === 'function_call_output').at(-1);
      const read = last ? JSON.parse(last.output) : null;
      const args = ++request === 1 ? { directory: '', offset: 0 } : request === 2 ? { path: '.gitignore' } : request === 3 ? { path: 'README.md' }
        : { summary: '已更新工程根目录的 .gitignore 和 README，src 无需修改。', files: [
          { path: '.gitignore', content: globalThis.rootIgnore + '**/.DS_Store\n' }, { path: 'README.md', content: '# Updated project root' }] };
      if (request === 2 && (!read.files.includes('.gitignore') || !read.files.includes('README.md') || !read.files.includes('src/main.ts')
        || read.files.some(path => path.startsWith('.dreamedge/')))) throw new Error('Project root scope missing');
      if (request === 3) globalThis.rootIgnore = read.content;
      const name = request === 1 ? 'list_files' : request < 4 ? 'read_file' : 'propose_changes';
      const tool = { id: `fc_${request}`, type: 'function_call', call_id: `call_${request}`, name, arguments: JSON.stringify(args) };
      const events = [{ type: 'response.created', response: { id: 'resp', status: 'in_progress' } },
        { type: 'response.output_item.added', output_index: 0, item: { ...tool, arguments: '' } },
        { type: 'response.output_item.done', output_index: 0, item: tool }, { type: 'response.completed', response: { id: 'resp', status: 'completed', output: [tool] } }];
      return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } });
    };
    function assertRoot(body) { if (!JSON.stringify(body).includes('BUSINESS PROJECT ROOT')) throw new Error('Old source-only prompt'); }
  });
  const chat = page.getByRole('region', { name: 'AI 会话' });
  await chat.getByLabel('修改需求', { exact: true }).fill('在工程根目录 .gitignore 处理所有 .DS_Store，并更新 README');
  await chat.getByRole('button', { name: '发送给 AI', exact: true }).click();
  await chat.getByText('已更新工程根目录的 .gitignore 和 README，src 无需修改。', { exact: true }).waitFor();
  await chat.getByText('修改已应用，页面已自动刷新。', { exact: true }).waitFor();
  assert.match(await readFile(join(directory, '.gitignore'), 'utf8'), /\*\*\/\.DS_Store/);
  assert.equal(await readFile(join(directory, 'README.md'), 'utf8'), '# Updated project root');
  assert.equal(await readFile(join(directory, '.dreamedge/model.json'), 'utf8'), keyFile);
  assert.equal(await chat.getByText('查看第 1 轮修改 · 2 个文件', { exact: true }).count(), 1);
  await page.frameLocator('iframe').getByText('HelloWorld', { exact: true }).waitFor();
  await mkdir('artifacts', { recursive: true }); await page.screenshot({ path: 'artifacts/dreamedge-project-root-ai.png' });
  assert.deepEqual(errors, []); console.log('PASS: pi agent project-root discovery/read, root .gitignore/README save, preserved renderer/key and automatic apply in desktop App.');
} finally { if (application) await application.close(); await rm(root, { recursive: true, force: true }); }
