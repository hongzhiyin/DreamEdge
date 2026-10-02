import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { _electron as electron } from 'playwright';
import electronPath from 'electron';

const business = process.argv[2] && resolve(process.argv[2]);
if (!business) throw new Error('请传入独立业务项目目录。');
const temporary = await mkdtemp(join(tmpdir(), 'dreamedge-derived-'));
const second = join(temporary, 'project');
const id = `io.example.p${Date.now()}`;
const apps = [];
const profiles = [];
function run(command, args, cwd = process.cwd()) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`${command} failed`);
}
async function launch(path) {
  const env = { ...process.env, CODEX_USAGE_EXECUTABLE: join(business, 'tests/fake-codex.cjs') };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.DREAMEDGE_DATA_DIR;
  const app = await electron.launch({ executablePath: electronPath, args: [path], env });
  apps.push(app);
  const page = await app.firstWindow();
  await page.locator('iframe').waitFor();
  const identity = await page.evaluate(() => window.dreamEdge.info());
  return { app, page, identity };
}
try {
  run(process.execPath, ['packages/cli/bin/cli.mjs', 'create', second, '--name', 'Isolation Check', '--id', id,
    '--runtime', resolve('artifacts/framework/dreamedge-desktop-0.1.1.tgz'),
    '--sdk', resolve('artifacts/framework/dreamedge-sdk-0.1.1.tgz'),
    '--cli', resolve('artifacts/framework/dreamedge-cli-0.1.1.tgz')]);
  run('npm', ['install', '--offline', '--ignore-scripts'], second);
  run('npm', ['run', 'build'], second);
  const a = await launch(business);
  const b = await launch(second);
  assert.notEqual(a.identity.appId, b.identity.appId);
  const aProfile = await a.app.evaluate(({ app }) => app.getPath('userData'));
  const bProfile = await b.app.evaluate(({ app }) => app.getPath('userData'));
  profiles.push(bProfile);
  assert.notEqual(aProfile, bProfile);
  assert.ok(aProfile.endsWith(a.identity.appId));
  assert.ok(bProfile.endsWith(b.identity.appId));
  const record = `check-${Date.now()}`;
  for (const [target, value] of [[a, 'A'], [b, 'B']]) {
    await target.page.evaluate(async ({ id, record, value }) => {
      await window.dreamEdge.storage(id, { operation: 'put', collection: 'isolation-check', id: record, value });
    }, { id: target.identity.id, record, value });
  }
  for (const [target, value] of [[a, 'A'], [b, 'B']]) {
    const rows = await target.page.evaluate(id => window.dreamEdge.storage(id, { operation: 'list', collection: 'isolation-check' }), target.identity.id);
    assert.equal(rows.find(row => row.id === record).value, value);
    await target.page.evaluate(({ id, record }) => window.dreamEdge.storage(id, { operation: 'remove', collection: 'isolation-check', id: record }), { id: target.identity.id, record });
  }
  console.log('PASS: generated independent project builds without framework source; two simultaneous App identities have separate default profiles and data.');
} finally {
  for (const app of apps) await app.close();
  await rm(temporary, { recursive: true, force: true });
  for (const profile of profiles) await rm(profile, { recursive: true, force: true });
}
