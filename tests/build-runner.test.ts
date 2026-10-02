import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { workerEngine } from '../desktop/build/runner';
import { BuildFailure } from '../desktop/build/types';

test('build worker receives a fixed command and no model credentials or Node preload options', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dreamedge-worker-'));
  const oldKey = process.env.DREAMEDGE_AI_API_KEY;
  try {
    process.env.DREAMEDGE_AI_API_KEY = 'fixture-key';
    const path = join(root, 'worker.cjs');
    await writeFile(path, 'process.stdin.resume(); process.stdin.on("end", () => process.stdout.write(JSON.stringify({ ok: true, result: { files: { "index.html": "HelloWorld" }, logs: [{ level: "info", message: String(Boolean(process.env.DREAMEDGE_AI_API_KEY || process.env.NODE_OPTIONS)) }] } })));');
    const result = await workerEngine(path)({ files: { 'index.html': 'source' } }, new AbortController().signal);
    assert.equal(result.logs[0].message, 'false'); assert.equal(result.files['index.html'], 'HelloWorld');
  } finally {
    if (oldKey === undefined) delete process.env.DREAMEDGE_AI_API_KEY; else process.env.DREAMEDGE_AI_API_KEY = oldKey;
    await rm(root, { recursive: true, force: true });
  }
});
test('cancelling a worker kills an unresponsive child and rejects invalid worker output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dreamedge-worker-'));
  try {
    const path = join(root, 'worker.cjs'); await writeFile(path, 'setInterval(() => {}, 1000);');
    const controller = new AbortController();
    const result = workerEngine(path)({ files: {} }, controller.signal);
    setTimeout(() => controller.abort('cancelled'), 30);
    await assert.rejects(result, error => error === 'cancelled');
    await writeFile(path, 'process.stdout.write("not-json");');
    await assert.rejects(workerEngine(path)({ files: {} }, new AbortController().signal), (error: unknown) => {
      assert.ok(error instanceof BuildFailure); assert.match(error.logs[0].message, /无效数据/); return true;
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});
