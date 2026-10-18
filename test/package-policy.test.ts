import test from 'node:test';
import assert from 'node:assert/strict';
import { packageExcluded, packagePaths } from '../scripts/package-policy.js';

test('Windows packaging includes the same runtime graph as macOS', () => {
  for (const path of ['/dist/web/server.js', '/dist/cli/main.js', '/dist/desktop/main.js', '/dist/src/launch/socket.js', '/config/deepseek.example.json']) {
    assert.equal(packageExcluded(path), false); assert.equal(packageExcluded(path.replaceAll('/', '\\')), false);
  }
  assert.deepEqual(packagePaths(['\\dist\\web\\server.js']), ['/dist/web/server.js']);
});
test('Windows and POSIX private paths are excluded', () => {
  for (const path of ['/config/credentials.local.json', '/.env', '/.env.production', '/docs/validation/data.json', '/dist/test/launch.test.js', '/.git/config']) {
    assert.equal(packageExcluded(path), true); assert.equal(packageExcluded(path.replaceAll('/', '\\')), true);
  }
});
