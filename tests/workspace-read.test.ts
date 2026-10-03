import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readText, writeText } from '../desktop/workspace/paths';

test('atomic text replacement remains readable as complete snapshots during concurrent progress updates', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dreamedge-progress-')); let done = false;
  try {
    await writeText(root, 'record.json', JSON.stringify({ revision: 0, padding: 'x'.repeat(10000) }));
    const writer = (async () => { try { for (let revision = 1; revision <= 80; revision++) await writeText(root, 'record.json', JSON.stringify({ revision, padding: 'x'.repeat(10000) })); } finally { done = true; } })();
    const readers = Array.from({ length: 4 }, async () => { do {
      const value = JSON.parse(await readText(root, 'record.json'));
      assert.ok(Number.isInteger(value.revision) && value.revision >= 0 && value.revision <= 80); assert.equal(value.padding.length, 10000);
    } while (!done); });
    const results = await Promise.allSettled([writer, ...readers]);
    for (const result of results) if (result.status === 'rejected') throw result.reason; assert.equal(JSON.parse(await readText(root, 'record.json')).revision, 80);
  } finally { await rm(root, { recursive: true, force: true }); }
});
