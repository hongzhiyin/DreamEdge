import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { _electron as electron } from 'playwright';
import electronPath from 'electron';
const exec = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), 'dreamedge-git-ui-')); const profile = join(root, 'profile'); await mkdir(profile);
const runGit = async (cwd, ...args) => (await exec('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', '-C', cwd, ...args], { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })).stdout.trim();
let application;
try {
  const env = { ...process.env, DREAMEDGE_DATA_DIR: profile };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'DREAMEDGE_AI_API_KEY', 'DREAMEDGE_AI_MODEL', 'DREAMEDGE_AI_BASE_URL']) delete env[key];
  application = await electron.launch({ executablePath: process.env.DREAMEDGE_EXECUTABLE_PATH || electronPath,
    args: process.env.DREAMEDGE_EXECUTABLE_PATH ? [] : [resolve('.')], env });
  const page = await application.firstWindow(); page.setDefaultTimeout(20000); const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.frameLocator('iframe').getByText('HelloWorld', { exact: true }).waitFor();
  await page.getByRole('button', { name: '打开开发侧栏' }).click();
  const directory = join(root, 'business');
  await application.evaluate(({ dialog }, path) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: path }); }, directory);
  await page.getByRole('button', { name: /^新建工程/ }).click(); await page.getByText('business', { exact: true }).waitFor();
  const bar = page.getByRole('region', { name: '工程 Git 状态' });
  await bar.getByText('未配置远程仓库', { exact: true }).waitFor();
  assert.equal(await bar.getByRole('button', { name: '提交', exact: true }).isDisabled(), true);
  assert.equal(await bar.getByRole('button', { name: '拉取', exact: true }).count(), 0);
  const modelFile = join(directory, '.dreamedge/model.json'); await writeFile(modelFile, '{"private":"fixture-key"}');
  await writeFile(join(directory, 'src/main.ts'), "document.getElementById('root').textContent='Hello Git';");
  await bar.getByRole('button', { name: '刷新 Git 状态' }).click();
  await bar.getByRole('button', { name: '提交', exact: true }).click();
  await bar.getByText('工程修改已提交 Git。', { exact: true }).waitFor(); const saved = await runGit(directory, 'rev-parse', 'HEAD');
  await writeFile(join(directory, 'src/main.ts'), "document.getElementById('root').textContent='Discard me';");
  await writeFile(join(directory, 'src/new.ts'), 'Uncommitted');
  await writeFile(join(directory, 'manual.txt'), 'Unrelated stage'); await runGit(directory, 'add', '--', 'manual.txt');
  await bar.getByRole('button', { name: '刷新 Git 状态' }).click();
  await bar.getByRole('button', { name: '撤销', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '撤销未提交的工程修改？' });
  await dialog.waitFor(); await dialog.getByRole('button', { name: '取消', exact: true }).click();
  assert.match(await readFile(join(directory, 'src/main.ts'), 'utf8'), /Discard me/);
  await bar.getByRole('button', { name: '撤销', exact: true }).click(); await dialog.getByRole('button', { name: '确认撤销', exact: true }).click();
  // External fixture writes can overlap a status read; retry only the explicit stale-state rejection.
  const result = await Promise.race([
    bar.getByText('未提交的工程修改已撤销，页面已刷新。', { exact: true }).waitFor().then(() => 'done'),
    bar.getByRole('alert').waitFor().then(async () => bar.getByRole('alert').textContent()),
  ]);
  if (result !== 'done') {
    assert.match(result, /状态已变化/);
    await bar.getByRole('button', { name: '撤销', exact: true }).click(); await dialog.getByRole('button', { name: '确认撤销', exact: true }).click();
  }
  await bar.getByText('未提交的工程修改已撤销，页面已刷新。', { exact: true }).waitFor();
  await page.frameLocator('iframe').getByText('Hello Git', { exact: true }).waitFor();
  assert.equal(await runGit(directory, 'rev-parse', 'HEAD'), saved);
  assert.equal(await runGit(directory, 'diff', '--cached', '--name-only'), 'manual.txt');
  assert.equal(await readFile(modelFile, 'utf8'), '{"private":"fixture-key"}');
  await assert.rejects(readFile(join(directory, 'src/new.ts')), { code: 'ENOENT' });
  // Clear only this fixture's unrelated file before the clean-tree pull acceptance.
  await runGit(directory, 'reset', '--', 'manual.txt'); await rm(join(directory, 'manual.txt'));
  const server = join(root, 'server.git'); await mkdir(server); await runGit(server, 'init', '--bare', '--initial-branch=main');
  await runGit(directory, 'remote', 'add', 'origin', server); await bar.getByRole('button', { name: '刷新 Git 状态' }).click();
  await bar.getByRole('button', { name: '推送', exact: true }).click(); await bar.getByText('本地提交已推送。', { exact: true }).waitFor();
  assert.equal(await runGit(server, 'rev-parse', 'refs/heads/main'), saved);
  const peer = join(root, 'peer'); await runGit(root, 'clone', server, peer);
  await runGit(peer, 'config', 'user.name', 'Peer'); await runGit(peer, 'config', 'user.email', 'peer@local');
  await writeFile(join(peer, 'src/main.ts'), "document.getElementById('root').textContent='Hello Remote';");
  await runGit(peer, 'add', '--', 'src'); await runGit(peer, 'commit', '-m', 'Remote greeting'); await runGit(peer, 'push');
  await page.getByRole('button', { name: '打开工程设置' }).click(); await page.getByRole('tab', { name: 'Git 历史', exact: true }).click();
  const history = page.getByRole('region', { name: 'Git 历史', exact: true });
  assert.equal(await page.getByLabel('本轮完成后提交工程修改到 Git', { exact: true }).count(), 0);
  await history.getByRole('button', { name: '查询远程状态', exact: true }).click();
  await history.getByText('远程待拉取记录', { exact: true }).waitFor(); await history.getByText('Remote greeting', { exact: true }).waitFor();
  await page.getByRole('button', { name: '返回 AI 对话' }).click();
  await bar.getByRole('button', { name: '拉取', exact: true }).click();
  await page.frameLocator('iframe').getByText('Hello Remote', { exact: true }).waitFor();
  await bar.getByText('远程内容已拉取，页面正在自动更新。', { exact: true }).waitFor();
  await page.getByRole('button', { name: '打开工程设置' }).click();
  await history.getByText('Remote greeting', { exact: true }).waitFor();
  assert.equal(await history.locator('.git-history').last().locator('li').first().locator('p').textContent(), 'Remote greeting');
  assert.ok(await history.locator('time[datetime]').count() >= 3);
  await history.getByRole('heading', { name: '最近提交', exact: true }).waitFor();
  assert.equal(await history.getByText('最新在前', { exact: false }).count(), 0);
  assert.equal(await history.getByRole('button', { name: '恢复此提交内容' }).count(), 0);
  assert.ok(await history.locator('.git-graph').count() >= 3);
  assert.equal(await history.locator('.git-history li').last().evaluate(row => row.getBoundingClientRect().height), 52);
  await runGit(directory, 'checkout', '-b', 'feature'); await writeFile(join(directory, 'feature.txt'), 'Feature branch');
  await runGit(directory, 'add', '--', 'feature.txt'); await runGit(directory, 'commit', '-m', 'Feature branch change');
  await runGit(directory, 'checkout', 'main'); await writeFile(join(directory, 'main.txt'), 'Main branch');
  await runGit(directory, 'add', '--', 'main.txt'); await runGit(directory, 'commit', '-m', 'Main branch change');
  await runGit(directory, 'merge', '--no-ff', '-m', 'Merge feature branch', 'feature');
  await history.getByRole('button', { name: '刷新 Git 状态', exact: true }).click();
  await history.getByText('Merge feature branch', { exact: true }).waitFor();
  assert.equal(await history.locator('.git-history li').first().locator('svg').getAttribute('width'), '34');
  assert.equal(await history.locator('.git-history li').first().locator('.git-head-label').textContent(), 'HEAD');
  const graphStatus = await page.evaluate(async () => {
    const { project } = await window.dreamEdge.workspace({ operation: 'current' });
    return window.dreamEdge.git({ operation: 'status', projectId: project.definition.id });
  });
  assert.equal(graphStatus.commits[0].parents.length, 2);
  await mkdir('artifacts', { recursive: true }); await page.screenshot({ path: 'artifacts/dreamedge-git-history.png' });
  await page.getByRole('button', { name: '返回 AI 对话' }).click();
  await page.screenshot({ path: 'artifacts/dreamedge-git-chat.png' });
  const native = await application.browserWindow(page); await native.evaluate(window => window.setSize(640, 480));
  const composer = await page.locator('.chat-composer').boundingBox(); assert.ok(composer.y >= 0 && composer.y + composer.height <= 480);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(errors, []);
  console.log('PASS: live Git bar, one-click commit, confirmed discard, unrelated stages/key preservation, first push, remote query, pull/refresh, dated history and compact layout.');
} finally { if (application) await application.close(); await rm(root, { recursive: true, force: true }); }
