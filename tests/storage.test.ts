import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ToolStorage } from '../desktop/storage';
import { assetPath } from '../desktop/assets';

test('records survive close and reopen; tools and collections stay isolated', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ideadock-storage-'));
  const filename = join(directory, 'data', 'test.sqlite');
  let db = new ToolStorage(filename);
  try {
    db.execute('reading-log', { operation: 'put', collection: 'entries', id: 'shared', value: { content: '原有阅读', minutes: 30 } });
    db.execute('second-tool', { operation: 'put', collection: 'entries', id: 'shared', value: { content: '独立数据' } });
    db.execute('reading-log', { operation: 'put', collection: 'settings', id: 'shared', value: { content: '配置' } });
    db.close();
    db = new ToolStorage(filename);
    assert.deepEqual(db.execute('reading-log', { operation: 'list', collection: 'entries' }), [
      { id: 'shared', value: { content: '原有阅读', minutes: 30 } },
    ]);
    db.execute('reading-log', { operation: 'put', collection: 'entries', id: 'shared', value: { content: '更新' } });
    db.execute('reading-log', { operation: 'remove', collection: 'entries', id: 'shared' });
    assert.deepEqual(db.execute('reading-log', { operation: 'list', collection: 'entries' }), []);
    assert.deepEqual(db.execute('second-tool', { operation: 'list', collection: 'entries' }), [
      { id: 'shared', value: { content: '独立数据' } },
    ]);
    assert.deepEqual(db.execute('reading-log', { operation: 'list', collection: 'settings' }), [
      { id: 'shared', value: { content: '配置' } },
    ]);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('storage rejects invalid operations, identifiers and payloads without changing records', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ideadock-validation-'));
  const db = new ToolStorage(join(directory, 'test.sqlite'));
  try {
    const invalid = [
      { operation: 'exec', collection: 'entries' },
      { operation: 'put', collection: '../secret', id: 'a', value: {} },
      { operation: 'put', collection: 'entries', id: 'a', value: { number: Infinity } },
      { operation: 'put', collection: 'entries', id: 'a', value: 'x'.repeat(65537) },
      { operation: 'put', collection: 'entries', id: 'a', value: undefined },
    ];
    for (const request of invalid) {
      assert.throws(() => db.execute('reading-log', request as never));
    }
    assert.deepEqual(db.execute('reading-log', { operation: 'list', collection: 'entries' }), []);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('asset loader serves only registered local roots', () => {
  assert.equal(assetPath('/app/dist', 'ideadock://reading-log/index.html'), '/app/dist/tools/reading-log/index.html');
  for (const url of ['file:///etc/passwd', 'ideadock://unknown/index.html', 'ideadock://shell/%2e%2e%2fsecret']) {
    assert.throws(() => assetPath('/app/dist', url));
  }
});
