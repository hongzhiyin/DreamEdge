import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { loadPiFileTools } from '../src/index.js';
import { piDetails } from '../src/files/pi-json.js';
import { piFiles } from './helpers/pi-files.js';

test('adapter requires explicit host gates; no default filesystem host exists', async () => {
  await assert.rejects(loadPiFileTools(undefined as never));
  await assert.rejects(loadPiFileTools({ prepare: async () => undefined } as never));
});

test('undefined object metadata is omitted; lossy numbers, arrays and cyclic metadata are rejected', () => {
  assert.deepEqual(piDetails({ nested: { missing: undefined, value: 1 }, list: [1, null] }), { nested: { value: 1 }, list: [1, null] });
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
  for (const value of [{ value: NaN }, [undefined], new Date(), cyclic]) assert.throws(() => piDetails(value));
});

test('wrong tool name or changed schema cannot dispatch and always disposes its binding', async t => {
  const f = await piFiles(t); let calls = 0; let disposed = 0;
  for (const change of [{ name: 'write' }, { parameters: { type: 'object', properties: {} } }]) {
    const tools = await loadPiFileTools({ async authorize() {}, async prepare() {
      return { tool: { ...f.source.read, ...change, async execute() { calls++; return { content: [], details: {} }; } } as AgentTool,
        async dispose() { disposed++; } };
    } });
    await assert.rejects(tools.find(tool => tool.name === 'read')!.execute({ path: 'input.txt' }, {
      sessionId: 's', runId: 'r', turnId: 't', toolCallId: 'c', signal: new AbortController().signal,
    }));
  }
  assert.equal(calls, 0); assert.equal(disposed, 2);
});

test('explicit Pi error results cannot become successful results', async t => {
  const f = await piFiles(t);
  const tools = await loadPiFileTools({ async authorize() {}, async prepare() {
    return { tool: { ...f.source.read, async execute() { return { isError: true, content: [{ type: 'text', text: 'private-error' }], details: {} }; } } };
  } });
  await assert.rejects(tools[0]!.execute({ path: 'input.txt' }, { sessionId: 's', runId: 'r', turnId: 't', toolCallId: 'c',
    signal: new AbortController().signal }), { message: 'Pi 文件工具返回失败。' });
});

test('updates are normalized and acknowledged before done; late updates are ignored', async t => {
  const f = await piFiles(t); let late!: () => void; let release!: () => void; const seen: unknown[] = [];
  const tools = await loadPiFileTools({ async authorize() {}, async prepare() {
    return { tool: { ...f.source.read, async execute(_id, _args, _signal, update) {
      update?.({ content: [{ type: 'text', text: 'progress' }], details: undefined });
      late = () => update?.({ content: [], details: {} }); return { content: [], details: undefined };
    } } };
  } });
  let settled = false;
  const pending = tools[0]!.execute({ path: 'input.txt' }, { sessionId: 's', runId: 'r', turnId: 't', toolCallId: 'c',
    signal: new AbortController().signal, async onUpdate(result) { seen.push(result); await new Promise<void>(done => { release = done; }); } })
    .then(result => { settled = true; return result; });
  while (!release) await new Promise(done => setImmediate(done));
  assert.equal(settled, false); release(); await pending; late(); await Promise.resolve();
  assert.equal(seen.length, 1);
});

test('binding may translate a path but cannot rewrite approved content', async t => {
  const f = await piFiles(t); let dispatched = false;
  const tools = await loadPiFileTools({ async authorize() {}, async prepare() {
    return { tool: { ...f.source.write, async execute() { dispatched = true; return { content: [], details: {} }; } },
      args: { path: 'translated.txt', content: 'changed' } };
  } });
  await assert.rejects(tools.find(tool => tool.name === 'write')!.execute({ path: 'original.txt', content: 'approved' }, {
    sessionId: 's', runId: 'r', turnId: 't', toolCallId: 'c', signal: new AbortController().signal,
  })); assert.equal(dispatched, false);
});

test('native Pi cancellation reaches injected operations and cannot expose their late result', async t => {
  const f = await piFiles(t); const pi = await import('@earendil-works/pi-coding-agent');
  let release!: (data: Buffer) => void; let started = false; let disposed = false;
  const tools = await loadPiFileTools({ async authorize() {}, async prepare() {
    return { tool: pi.createReadTool(f.directory, { operations: { async access() {},
      async detectImageMimeType() { return undefined; },
      readFile: async () => { started = true; return new Promise<Buffer>(done => { release = done; }); } } }),
      async dispose() { disposed = true; } };
  } });
  const controller = new AbortController();
  const pending = tools[0]!.execute({ path: 'input.txt' }, { sessionId: 's', runId: 'r', turnId: 't', toolCallId: 'c', signal: controller.signal });
  while (!started) await new Promise(done => setImmediate(done)); controller.abort();
  await assert.rejects(pending); assert.equal(disposed, true); release(Buffer.from('late')); await Promise.resolve();
});

test('update observer failure is controlled rather than an unhandled async rejection', async t => {
  const f = await piFiles(t);
  const tools = await loadPiFileTools({ async authorize() {}, async prepare() {
    return { tool: { ...f.source.read, async execute(_id, _args, _signal, update) {
      update?.({ content: [], details: {} }); return { content: [], details: {} };
    } } };
  } });
  await assert.rejects(tools[0]!.execute({ path: 'input.txt' }, { sessionId: 's', runId: 'r', turnId: 't', toolCallId: 'c',
    signal: new AbortController().signal, async onUpdate() { throw new Error('private observer'); } }), { message: '文件工具更新处理失败。' });
});
