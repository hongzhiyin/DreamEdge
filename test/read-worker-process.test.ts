import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { stopReadProcessTree } from '../src/files/read-worker-process.js';

test('Windows worker cancellation waits for the native descendant process to exit', {
  skip: process.platform !== 'win32', timeout: 15_000,
}, async t => {
  const child = spawn(process.execPath, ['-e', `
    const { spawn } = require('node:child_process');
    const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
    grandchild.once('spawn', () => process.stdout.write(String(grandchild.pid)));
    setInterval(() => {}, 1000);
  `], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) await stopReadProcessTree(child); });
  const closed = once(child, 'close');
  const [data] = await once(child.stdout!, 'data'); const descendant = Number(String(data));
  assert.ok(Number.isSafeInteger(descendant) && descendant > 0);
  process.kill(descendant, 0);
  await stopReadProcessTree(child); await closed;
  assert.throws(() => process.kill(descendant, 0), { code: 'ESRCH' });
});
