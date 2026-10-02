import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dependencies, registryUrl, validateLock } from '../desktop/dependencies/policy';
import { resolveLock } from '../desktop/dependencies/resolve';
import { packageRegistry } from './dependency-fixture';
import { compile } from '../desktop/build/compiler';

test('dependency policy accepts exact public versions and rejects tags, URLs, local paths and lock traversal', async () => {
  assert.deepEqual({ ...dependencies({ '@example/browser': '1.2.3' }) }, { '@example/browser': '1.2.3' });
  for (const version of ['latest', '^1.2.3', 'file:../../secret', 'https://evil.test/pkg.tgz', 'github:user/repo']) assert.throws(() => dependencies({ react: version }));
  for (const url of ['http://registry.npmjs.org/a.tgz', 'https://evil.test/a.tgz', 'https://user:secret@registry.npmjs.org/a.tgz', 'https://registry.npmjs.org/a.tgz?token=x']) assert.throws(() => registryUrl(url));
  const f = await packageRegistry(); await f.add('a', '1.0.0', { 'index.js': 'export default 1' });
  const lock = await resolveLock({ a: '1.0.0' }, f.registry, new AbortController().signal, async () => {});
  assert.throws(() => validateLock({ ...lock, packages: { '../escape': lock.packages['node_modules/a'] } }, lock.dependencies));
  assert.throws(() => validateLock(lock, { a: '2.0.0' }));
});
test('resolver locks nested incompatible versions, enforces peers and terminates cyclic dependency graphs', async () => {
  const f = await packageRegistry();
  await f.add('a', '1.0.0', {}, { shared: '^1.0.0' }, { peer: '^1.0.0' });
  await f.add('b', '1.0.0', {}, { shared: '^2.0.0' });
  await f.add('shared', '1.0.0', {}, { a: '^1.0.0' }); await f.add('shared', '2.0.0', {}); await f.add('peer', '1.0.0', {});
  const run = (declared: Record<string, string>) => resolveLock(declared, f.registry, new AbortController().signal, async () => {});
  await assert.rejects(run({ a: '1.0.0' }), /peer/);
  const lock = await run({ a: '1.0.0', b: '1.0.0', peer: '1.0.0' });
  assert.equal(lock.packages['node_modules/a/node_modules/shared'].version, '1.0.0');
  assert.equal(lock.packages['node_modules/b/node_modules/shared'].version, '2.0.0');
  assert.equal(Object.keys(lock.packages).length, 5);
});
test('compiler uses locked browser exports, nested dependencies and rejects undeclared imports without filesystem access', async () => {
  const f = await packageRegistry();
  await f.add('widget', '1.0.0', {}, { shared: '^1.0.0' }); await f.add('shared', '1.0.0', {});
  const lock = await resolveLock({ widget: '1.0.0' }, f.registry, new AbortController().signal, async () => {});
  const files = {
    'node_modules/widget/package.json': JSON.stringify({ exports: { '.': { 'react-server': './server.js', browser: './browser.js' }, './sub': './sub.js' } }),
    'node_modules/widget/browser.js': "import { suffix } from 'shared';export const text='HelloWorld'+suffix;",
    'node_modules/widget/sub.js': 'export const sub=1;',
    'node_modules/widget/node_modules/shared/package.json': '{"main":"index.js"}',
    'node_modules/widget/node_modules/shared/index.js': "export const suffix=' locked';",
  };
  const compileImport = (path: string) => compile({ files: { 'index.html': '<script type="module" src="./main.ts"></script>', 'main.ts': `import {text} from '${path}';document.body.textContent=text;` }, dependencyLock: lock, dependencyFiles: files });
  assert.match((await compileImport('widget')).files['__dreamedge_bundle/module0.js'], /locked/);
  for (const path of ['node:fs', 'https://evil.test/module.js', '/etc/passwd', 'shared', 'widget/server']) await assert.rejects(compileImport(path));
});
