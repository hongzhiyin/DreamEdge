import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { containedPath, validateManifest, servicePath, applicationDataDirectory } from '../desktop/project';
import { createServices } from '../desktop/services';
import { serveAsset } from '../desktop/assets';

const manifest = { id: 'example', appId: 'io.example.app', name: 'Example', description: 'Test',
  version: '1.0.0', entry: 'index.html', renderer: 'ui', capabilities: ['service:local'],
  services: { local: { entry: 'service.cjs', methods: ['read'] } } };
test('different installed App identities select independent profiles', () => {
  assert.equal(applicationDataDirectory('/profiles', manifest), join('/profiles', 'io.example.app'));
  assert.notEqual(applicationDataDirectory('/profiles', manifest), applicationDataDirectory('/profiles', { appId: 'io.example.second' }));
  assert.throws(() => applicationDataDirectory('/profiles', { appId: '../app' }));
});
test('application manifest rejects injected identities, invalid permissions and escaping paths', () => {
  assert.equal(validateManifest(manifest).appId, 'io.example.app');
  for (const value of [
    { ...manifest, id: 'shell' },
    { ...manifest, id: 'evil; frame-src https://example.com' },
    { ...manifest, renderer: '../outside' }, { ...manifest, appId: '../profile' },
    { ...manifest, services: { local: { entry: '/outside.cjs', methods: ['read'] } } },
    { ...manifest, services: { local: { entry: 'service.cjs', methods: [''] } } },
  ]) assert.throws(() => validateManifest(value));
  assert.throws(() => containedPath('/application', '../../outside'));
});
test('local services require declared capability and method, and preserve application identity', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dreamedge-services-'));
  try {
    writeFileSync(join(root, 'service.cjs'), 'exports.execute = async (method, input, context) => ({ appId: context.appId, input });');
    const service = createServices(manifest, root, join(root, 'data'));
    assert.deepEqual(await service('local', 'read', { query: true }), { appId: 'io.example.app', input: { query: true } });
    await assert.rejects(service('local', 'write', null), /未声明/);
    await assert.rejects(service('__proto__', 'read', null), /未声明/);
    await assert.rejects(service('local', 'read', { number: Infinity }), /无效/);
    await assert.rejects(createServices({ ...manifest, capabilities: [] }, root, root)('local', 'read', null), /未声明/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('service modules cannot escape the app through a symbolic link', () => {
  const root = mkdtempSync(join(tmpdir(), 'dreamedge-paths-'));
  try {
    symlinkSync(process.execPath, join(root, 'service.cjs'));
    assert.throws(() => servicePath(root, 'service.cjs'), /越界/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('content policy admits only the current application frame', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dreamedge-assets-'));
  try {
    mkdirSync(join(root, 'shell'));
    writeFileSync(join(root, 'shell/index.html'), 'hello');
    const response = await serveAsset(root, 'dreamedge://shell/index.html', [manifest]);
    assert.equal(response.status, 200);
    assert.ok(response.headers.get('Content-Security-Policy')!.includes('frame-src dreamedge://example;'));
    assert.ok(!response.headers.get('Content-Security-Policy')!.includes('other-app'));
    const forbidden = await serveAsset(root, 'dreamedge://other/index.html', [manifest]);
    assert.equal(forbidden.status, 404);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
