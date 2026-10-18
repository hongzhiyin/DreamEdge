import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { ToolRegistry, builtInTools, piFileToolNames, toolSnapshot } from '../src/index.js';
import { piFiles } from './helpers/pi-files.js';

test('fixed Pi SDK exports all six file tools with closed portable schemas and mandatory write approval', async t => {
  const f = await piFiles(t); const registry = new ToolRegistry();
  for (const tool of f.definitions) registry.register(tool);
  assert.deepEqual(registry.snapshots().map(tool => tool.name), [...piFileToolNames]);
  for (const snapshot of registry.snapshots()) {
    assert.equal(snapshot.parameters.additionalProperties, false); assert.equal(snapshot.version, 'pi-1.1.0/adapter-1');
    assert.equal(snapshot.approval, ['write', 'edit'].includes(snapshot.name) ? 'always' : 'never');
    assert.ok(!JSON.stringify(snapshot).includes('execute'));
  }
  const edit = registry.snapshots(['edit'])[0]!;
  const properties = edit.parameters.properties as Record<string, { items: { additionalProperties: boolean } }>;
  assert.equal(properties.edits!.items.additionalProperties, false);
  assert.equal(f.counts.prepare, 0); assert.deepEqual(builtInTools().snapshots().map(tool => tool.name), ['get_current_time', 'add_numbers']);
});

test('Pi read keeps real line windows, normalizes absent metadata and copies payloads', async t => {
  const f = await piFiles(t); const result = await f.execute('read', { path: 'input.txt', offset: 2, limit: 1 });
  assert.ok(result.content.some(block => block.type === 'text' && block.text.includes('beta')));
  assert.ok(result.content.every(block => block.type !== 'text' || !block.text.includes('alpha')));
  assert.doesNotThrow(() => JSON.stringify(result)); assert.equal(f.counts.dispose, 1);
});

test('Pi ls and injected find keep upstream list/search behavior', async t => {
  const f = await piFiles(t);
  for (const [name, args] of [['ls', { path: '.' }], ['find', { pattern: '*.txt', path: '.' }]] as const) {
    const result = await f.execute(name, args); assert.ok(result.content.some(block => block.type === 'text' && block.text.includes('input.txt')));
  }
});

test('Pi write and edit preserve actual text transforms, including several edits against the original file', async t => {
  const f = await piFiles(t); await f.execute('write', { path: 'output.txt', content: 'red\ngreen\nblue\n' });
  const result = await f.execute('edit', { path: 'output.txt', edits: [
    { oldText: 'red', newText: 'pink' }, { oldText: 'blue', newText: 'navy' },
  ] });
  assert.equal(await readFile(resolve(f.directory, 'output.txt'), 'utf8'), 'pink\ngreen\nnavy\n');
  assert.ok(result.details && typeof result.details === 'object' && !Array.isArray(result.details));
  assert.ok(JSON.stringify(result.details).includes('patch')); assert.equal(f.counts.dispose, 2);
});

test('Pi edit rejects ambiguous matches without writing a changed file', async t => {
  const f = await piFiles(t); await f.execute('write', { path: 'duplicates.txt', content: 'red\nred\n' });
  await assert.rejects(f.execute('edit', { path: 'duplicates.txt', edits: [{ oldText: 'red', newText: 'blue' }] }));
  assert.equal(await readFile(resolve(f.directory, 'duplicates.txt'), 'utf8'), 'red\nred\n');
});

test('invalid fields and outdated edit parameters fail before host authorization or preparation', async t => {
  const f = await piFiles(t);
  for (const args of [{ path: 'input.txt', oldText: 'alpha', newText: 'x' },
    { path: 'input.txt', edits: [{ oldText: 'alpha', newText: 'x', extra: true }] }]) {
    await assert.rejects(f.execute('edit', args), { code: 'INVALID_TOOL_ARGUMENTS' });
  }
  await assert.rejects(f.execute('read', { path: 'input.txt', cwd: '/' }), { code: 'INVALID_TOOL_ARGUMENTS' });
  assert.equal(f.counts.authorize, 0); assert.equal(f.counts.prepare, 0);
});

test('host denial and an already-aborted call cannot dispatch Pi executors', async t => {
  const f = await piFiles(t);
  await assert.rejects(f.execute('read', { path: '../outside.txt' })); assert.equal(f.counts.prepare, 0);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.execute('write', { path: 'not-created.txt', content: 'x' }, controller.signal));
  assert.equal(f.counts.prepare, 0); assert.equal(f.counts.authorize, 1);
});

test('adapter metadata and schemas remain immutable', async t => {
  const f = await piFiles(t); const read = f.definitions.find(tool => tool.name === 'read')!;
  assert.ok(Object.isFrozen(read) && Object.isFrozen(read.parameters));
  assert.equal(toolSnapshot(read).parameters.additionalProperties, false);
});

test('Pi grep executes the available ripgrep against the isolated fixture', async t => {
  const f = await piFiles(t); const result = await f.execute('grep', { pattern: 'beta', path: 'input.txt', literal: true });
  assert.ok(result.content.some(block => block.type === 'text' && block.text.includes('input.txt:2: beta')));
  assert.equal(f.counts.dispose, 1);
});
