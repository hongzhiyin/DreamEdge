import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, rm, symlink, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { c } from 'tar';
import { unpackArchive } from '../desktop/dependencies/archive';
import { NpmRegistry } from '../desktop/dependencies/registry';

test('dependency extraction rejects symbolic links and oversized entries without touching an external file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dreamedge-unsafe-archive-'));
  try {
    const external = join(root, 'outside'); await writeFile(external, 'keep');
    await mkdir(join(root, 'package')); await mkdir(join(root, 'target'));
    await symlink(external, join(root, 'package/link'));
    const bytes: Buffer[] = []; for await (const chunk of c({ cwd: root, gzip: true }, ['package'])) bytes.push(chunk);
    await assert.rejects(unpackArchive(Buffer.concat(bytes), join(root, 'target'), new AbortController().signal), /链接|路径/);
    assert.equal(await readFile(external, 'utf8'), 'keep');
    await rm(join(root, 'package/link')); await writeFile(join(root, 'package/oversized.js'), 'x'.repeat(4 * 1024 * 1024 + 1));
    const large: Buffer[] = []; for await (const chunk of c({ cwd: root, gzip: true }, ['package'])) large.push(chunk);
    await assert.rejects(unpackArchive(Buffer.concat(large), join(root, 'target'), new AbortController().signal), /大小限制/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('registry sends no credentials, forbids redirects and rejects off-registry or platform package metadata', async () => {
  const original = globalThis.fetch; const registry = new NpmRegistry(); const signal = new AbortController().signal;
  try {
    globalThis.fetch = async (input, options) => {
      assert.equal(new URL(String(input)).origin, 'https://registry.npmjs.org');
      assert.equal(options?.redirect, 'error'); assert.deepEqual(options?.headers, { accept: 'application/json' });
      return new Response(JSON.stringify({ name: 'example', version: '1.0.0', dist: { tarball: 'https://evil.test/a.tgz', integrity: 'sha512-' + 'A'.repeat(86) + '==' } }));
    };
    await assert.rejects(registry.resolve('example', '1.0.0', signal), /公共仓库/);
    globalThis.fetch = async () => new Response(JSON.stringify({ name: 'example', version: '1.0.0', os: ['linux'] }));
    await assert.rejects(registry.resolve('example', '1.0.0', signal), /平台依赖/);
  } finally { globalThis.fetch = original; }
});
