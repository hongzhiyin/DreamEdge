import assert from 'node:assert/strict';
import test from 'node:test';
import { writeFile, mkdir, readdir, symlink, link, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { scopedReadTools } from '../src/index.js';
import { scopeFixture } from './helpers/file-scopes.js';

async function fixture(t: Parameters<typeof scopeFixture>[0], limits = {}) {
  const f = await scopeFixture(t); await f.choose({ mode: 'read', remember: true }); const { source } = f.start();
  const cacheRoot = join(f.directory, 'cache'); await mkdir(cacheRoot, { mode: 0o700 });
  const definitions = await scopedReadTools(f.service.fileScopes, limits, cacheRoot); const signal = new AbortController();
  const run = async (name: string, args: Record<string, string | number | boolean> = {}) => definitions.find(t => t.name === name)!
    .execute(args, { ...source, signal: signal.signal });
  return { ...f, definitions, signal, run, cacheRoot };
}
const text = (result: Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>['run']>>) => result.content.filter(x => x.type === 'text').map(x => x.text).join('\n');

test('only four Pi read tools are exposed; native text window preserves upstream semantics and source metadata', async t => {
  const f = await fixture(t); assert.deepEqual(f.definitions.map(t => t.name), ['read', 'ls', 'find', 'grep']);
  await writeFile(join(f.root, 'input.txt'), 'one\ntwo\nthree\n');
  const result = await f.run('read', { path: 'input.txt', offset: 2, limit: 1 });
  assert.match(text(result), /two/); assert.doesNotMatch(text(result), /one|dreamedge-file-snapshot/);
  const metadata = result.details as { fileAccess: { path: string; files: { complete: boolean }[] } };
  assert.equal(metadata.fileAccess.path, join(f.root, 'input.txt')); assert.equal(metadata.fileAccess.files[0]!.complete, false);
});
test('real Pi directory listing and glob search exclude secrets and links before processing', async t => {
  const f = await fixture(t); await mkdir(join(f.root, 'nested')); await writeFile(join(f.root, 'nested/a.ts'), 'needle');
  await writeFile(join(f.root, '.ENV'), 'excluded needle'); await symlink(f.outside, join(f.root, 'link'));
  await link(join(f.outside, 'secret.txt'), join(f.root, 'hard'));
  const listed = text(await f.run('ls')); assert.match(listed, /nested\//); assert.doesNotMatch(listed, /\.ENV|link\/|hard/);
  const found = text(await f.run('find', { pattern: '**/*.ts' })); assert.match(found, /nested\/a.ts/);
  assert.doesNotMatch(found, /outside|snapshot/);
});
test('Pi grep uses the packaged binary and searches only bounded authorized snapshots, including context and literals', async t => {
  const f = await fixture(t); await writeFile(join(f.root, 'input.txt'), 'before\nneedle.*\nafter\n');
  await writeFile(join(f.outside, 'secret.txt'), 'outside needle'); await symlink(f.outside, join(f.root, 'escaped'));
  await writeFile(join(f.root, '.env'), 'secret needle');
  const result = text(await f.run('grep', { pattern: 'needle.*', literal: true, context: 1 }));
  assert.match(result, /input.txt:2: needle\.\*/); assert.match(result, /before|after/);
  assert.doesNotMatch(result, /outside|secret needle|snapshot/);
  assert.match(text(await f.run('grep', { pattern: 'no-match' })), /No matches found/);
});
test('upstream truncation is preserved and never records a complete file view', async t => {
  const f = await fixture(t); await writeFile(join(f.root, 'input.txt'), Array.from({ length: 2200 }, (_, n) => `line ${n}`).join('\n'));
  const result = await f.run('read', { path: 'input.txt' }); assert.match(text(result), /Showing lines/);
  assert.equal((result.details as { fileAccess: { files: { complete: boolean }[] } }).fileAccess.files[0]!.complete, false);
});
test('byte, entry, depth and numeric limits fail closed and temporary snapshots are cleaned', async t => {
  const f = await fixture(t, { fileBytes: 16, totalBytes: 16, entries: 2, depth: 1 });
  await assert.rejects(f.run('read', { path: 'input.txt' }), { code: 'FILE_TOO_LARGE' });
  await writeFile(join(f.root, 'a'), 'a'); await writeFile(join(f.root, 'b'), 'b');
  await assert.rejects(f.run('find', { pattern: '**/*' }), { code: 'FILE_TOO_LARGE' });
  await assert.rejects(f.run('read', { path: 'a', offset: 0 }), { code: 'FILE_SCOPE_INVALID' });
  await assert.rejects(f.run('grep', { pattern: 'a', context: 999 }), { code: 'FILE_SCOPE_INVALID' });
  assert.deepEqual(await readdir(f.cacheRoot), []);
});
test('revoked, ambiguous, outside and cancelled access never dispatches a successful read', async t => {
  const f = await fixture(t); await assert.rejects(f.run('read', { path: join(f.outside, 'secret.txt') }));
  await f.choose({ mode: 'read', remember: true }); await assert.rejects(f.run('read', { path: 'input.txt' }));
  const grant = f.service.fileScopes.snapshot(f.session.sessionId).grants[0]!; f.service.fileScopes.revoke(f.session.sessionId, grant.grantId);
  f.signal.abort(); await assert.rejects(f.run('read', { path: join(f.root, 'input.txt') }));
});

test('worker environment discards host ripgrep configuration, agent binaries and Node preload options', async t => {
  const f = await fixture(t); const marker = join(f.directory, 'unexpected-side-effect');
  const preload = join(f.directory, 'preload.cjs'); await writeFile(preload, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'bad')`);
  const config = join(f.directory, 'rg-config'); await writeFile(config, '--pre\n/invalid-command\n');
  const saved = { node: process.env.NODE_OPTIONS, rg: process.env.RIPGREP_CONFIG_PATH, pi: process.env.PI_CODING_AGENT_DIR };
  Object.assign(process.env, { NODE_OPTIONS: `--require=${preload}`, RIPGREP_CONFIG_PATH: config, PI_CODING_AGENT_DIR: f.outside });
  try { assert.match(text(await f.run('grep', { pattern: 'authorized' })), /authorized contents/); await assert.rejects(access(marker)); }
  finally { for (const [key, value] of [['NODE_OPTIONS', saved.node], ['RIPGREP_CONFIG_PATH', saved.rg], ['PI_CODING_AGENT_DIR', saved.pi]] as const) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  } }
});
test('search respects snapshot-local ignore files, rejects malformed regex and bounds match count', async t => {
  const f = await fixture(t); await writeFile(join(f.root, '.gitignore'), 'ignored.txt\n');
  await writeFile(join(f.root, 'ignored.txt'), 'ignored needle'); await writeFile(join(f.root, 'input.txt'), 'needle one\nneedle two\n');
  assert.doesNotMatch(text(await f.run('find', { pattern: '*.txt' })), /ignored/);
  const result = text(await f.run('grep', { pattern: 'needle', limit: 1 })); assert.match(result, /limit reached/); assert.doesNotMatch(result, /ignored needle/);
  await assert.rejects(f.run('grep', { pattern: '[' }), { code: 'FILE_IO_FAILED' }); assert.deepEqual(await readdir(f.cacheRoot), []);
});
test('worker timeout settles and removes its private snapshot without storing a result', async t => {
  const f = await fixture(t, { timeoutMs: 50 });
  await assert.rejects(f.run('read', { path: 'input.txt' }));
  assert.deepEqual(await readdir(f.cacheRoot), []); assert.deepEqual(f.service.fileScopes.snapshot(f.session.sessionId).observations, []);
});
test('recursive depth and total byte limits do not silently return incomplete search results', async t => {
  const f = await fixture(t, { fileBytes: 32, totalBytes: 32, depth: 1 });
  await writeFile(join(f.root, 'extra.txt'), 'x'.repeat(24)); await assert.rejects(f.run('grep', { pattern: 'x' }), { code: 'FILE_TOO_LARGE' });
  await mkdir(join(f.root, 'a')); await mkdir(join(f.root, 'a/b'));
  await assert.rejects(f.run('find', { pattern: '**/*' }), { code: 'FILE_TOO_LARGE' }); assert.deepEqual(await readdir(f.cacheRoot), []);
});
