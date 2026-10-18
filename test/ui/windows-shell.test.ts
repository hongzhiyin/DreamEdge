import test from 'node:test';
import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('packaged Windows desktop opens its chat and offers a graceful quit with an isolated profile', {
  skip: process.platform !== 'win32', timeout: 45000,
}, async t => {
  const executablePath = process.env.DREAMEDGE_PACKAGE_EXECUTABLE;
  assert.ok(executablePath, 'Set DREAMEDGE_PACKAGE_EXECUTABLE to the packaged Windows executable');
  const profile = await mkdtemp(join(tmpdir(), 'dreamedge-shell-'));
  const env = { ...process.env, DREAMEDGE_DATA_DIR: profile, DREAMEDGE_NO_DIALOGS: '1' };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'DREAMEDGE_CONFIG_FILE', 'DREAMEDGE_CREDENTIALS_FILE']) delete env[key as keyof typeof env];
  const app = await electron.launch({ executablePath, args: [], env });
  t.after(async () => { await app.close().catch(() => {}); await rm(profile, { recursive: true, force: true }); });
  const window = await app.firstWindow();
  await window.locator('#chat-input').waitFor();
  assert.equal(await app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById('app-quit')?.role), 'quit');
  assert.deepEqual(JSON.parse(await readFile(join(profile, 'credentials.local.json'), 'utf8')), { deepseek: '' });
  assert.equal(await app.evaluate(({ app }) => app.getPath('userData')), profile);
  await app.close();
});
