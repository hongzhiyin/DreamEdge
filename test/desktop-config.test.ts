import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { desktopConfig } from '../desktop/config.js';

test('packaged defaults are created outside the bundle and existing configuration is preserved', async t => {
  const userData = await mkdtemp(join(tmpdir(), 'dreamedge-config-'));
  t.after(() => rm(userData, { recursive: true, force: true }));
  const options = { userData, packaged: true, environment: {} };
  const initial = await desktopConfig(process.cwd(), options);
  assert.equal(initial.config.model, 'deepseek-flash');
  assert.equal(await initial.credentials('file:deepseek', new AbortController().signal), undefined);
  const path = join(userData, 'credentials.local.json');
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  await writeFile(path, JSON.stringify({ deepseek: 'local-fixture-key' }));
  const configPath = join(userData, 'connection.local.json');
  const config = JSON.parse(await readFile(configPath, 'utf8')); config.model = 'local-model';
  await writeFile(configPath, JSON.stringify(config));
  const again = await desktopConfig(process.cwd(), options);
  assert.equal(again.config.model, 'local-model');
  assert.equal(await again.credentials('file:deepseek', new AbortController().signal), 'local-fixture-key');
});
