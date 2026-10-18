import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { launchDataDirectory } from '../src/launch/paths.js';
import { newWindowsPipe, saveWindowsPipe, readWindowsPipe } from '../src/launch/windows-control.js';

test('Windows CLI uses Electron roaming data path and respects explicit profiles', () => {
  assert.equal(launchDataDirectory('win32', { APPDATA: '/fixture/roaming' }), join('/fixture/roaming', 'DreamEdge'));
  assert.equal(launchDataDirectory('win32', { DREAMEDGE_DATA_DIR: './other' }), resolve('./other'));
});
test('pipe discovery is random, bounded and rejects substituted endpoints', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pipe-discovery-'));
  try {
    const one = newWindowsPipe(), two = newWindowsPipe(); assert.notEqual(one, two);
    await saveWindowsPipe(directory, one); assert.equal(await readWindowsPipe(directory), one);
    await saveWindowsPipe(directory, two); assert.equal(await readWindowsPipe(directory), two);
    await writeFile(join(directory, 'control-pipe'), '\\\\remote\\pipe\\other');
    await assert.rejects(readWindowsPipe(directory), /控制入口/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
