import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { ToolStorage } from '../desktop/storage';
import { assetPath } from '../desktop/assets';
const sample = { id: 'hello-world', name: 'Framework fixture', description: '', version: '0.1.0', entry: 'index.html', capabilities: ['storage'] };

test('records survive close and reopen; tools and collections stay isolated', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dreamedge-storage-'));
  const filename = join(directory, 'data', 'test.sqlite');
  let db = new ToolStorage(filename);
  try {
    db.execute('hello-world', { operation: 'put', collection: 'entries', id: 'shared', value: { content: '框架测试值', minutes: 30 } });
    db.execute('second-tool', { operation: 'put', collection: 'entries', id: 'shared', value: { content: '独立数据' } });
    db.execute('hello-world', { operation: 'put', collection: 'settings', id: 'shared', value: { content: '配置' } });
    db.close();
    db = new ToolStorage(filename);
    assert.deepEqual(db.execute('hello-world', { operation: 'list', collection: 'entries' }), [
      { id: 'shared', value: { content: '框架测试值', minutes: 30 } },
    ]);
    db.execute('hello-world', { operation: 'put', collection: 'entries', id: 'shared', value: { content: '更新' } });
    db.execute('hello-world', { operation: 'remove', collection: 'entries', id: 'shared' });
    assert.deepEqual(db.execute('hello-world', { operation: 'list', collection: 'entries' }), []);
    assert.deepEqual(db.execute('second-tool', { operation: 'list', collection: 'entries' }), [
      { id: 'shared', value: { content: '独立数据' } },
    ]);
    assert.deepEqual(db.execute('hello-world', { operation: 'list', collection: 'settings' }), [
      { id: 'shared', value: { content: '配置' } },
    ]);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('storage rejects invalid operations, identifiers and payloads without changing records', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dreamedge-validation-'));
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
      assert.throws(() => db.execute('hello-world', request as never));
    }
    assert.deepEqual(db.execute('hello-world', { operation: 'list', collection: 'entries' }), []);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('asset loader serves only registered local roots', () => {
  const dist = resolve('test-dist');
  assert.equal(assetPath(dist, 'dreamedge://hello-world/index.html', [sample]), join(dist, 'tools', 'hello-world', 'index.html'));
  for (const url of ['file:///etc/passwd', 'dreamedge://unknown/index.html', 'dreamedge://shell/%2e%2e%2fsecret']) {
    assert.throws(() => assetPath(dist, url, [sample]));
  }
});
