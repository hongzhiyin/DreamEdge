import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ResponsesModel } from '../desktop/development/responses';
import { recordEvent, validateEvents } from '../desktop/development/timeline';
import { fixture, proposal, deferred } from './development-fixture';
import { providerResponse } from './provider-fixture';
import type { DevelopmentTurn } from '../shared/contracts';

const configuration = { apiKey: 'fixture-timeline-secret', model: 'test', baseUrl: 'https://model.example/v1' };
const call = (id: string, name: string, args: object) => ({ type: 'function_call', call_id: id, name, arguments: JSON.stringify(args) });
async function until(f: Awaited<ReturnType<typeof fixture>>, predicate: (turn: DevelopmentTurn) => boolean) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) { const turn = (await f.get()).turns.at(-1)!; if (predicate(turn)) return turn; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('Timeline update did not arrive');
}
test('pi response summaries, messages and tool calls are persisted in order with live running status and collapsed details', async () => {
  const f = await fixture(async () => proposal); const reply = deferred<void>(); const execute = deferred<void>(); let requests = 0;
  const model = new ResponsesModel(configuration, async () => {
    if (++requests === 1) {
      await reply.promise;
      return providerResponse([
        { type: 'reasoning', id: 'reasoning', encrypted_content: 'opaque-signature-never-display', summary: [{ type: 'summary_text', text: '先读取源码，再修改问候语。' }] },
        { type: 'message', content: [{ type: 'output_text', text: '我会先检查当前页面。' }] },
        call('read', 'read_file', { path: 'main.ts' }),
      ]);
    }
    return providerResponse([call('submit', 'propose_changes', proposal)]);
  });
  f.provider.generate = (input, signal, access) => model.generate(input, signal, { ...access!, execute: async (...args) => {
    if (args[0] === 'read_file') await execute.promise; return access!.execute(...args);
  } });
  try {
    await f.send(); await until(f, turn => turn.events?.[0]?.status === 'running'); reply.resolve();
    const running = await until(f, turn => turn.events?.some(event => event.tool === 'read_file' && event.status === 'running') ?? false);
    assert.deepEqual(running.events?.map(event => event.kind), ['model', 'thinking', 'message', 'tool']);
    assert.equal(running.events?.[1].content, '先读取源码，再修改问候语。');
    assert.ok(running.events?.at(-1)?.input?.includes('main.ts')); execute.resolve();
    const turn = (await f.settled()).turns[0]; assert.equal(turn.status, 'completed', turn.error ?? '');
    assert.equal(turn.events?.at(-1)?.tool, 'propose_changes'); assert.ok(turn.events?.find(event => event.tool === 'read_file')?.output?.includes('HelloWorld'));
    assert.ok(!JSON.stringify(turn.events).includes('opaque-signature')); assert.ok(!JSON.stringify(turn.events).includes(configuration.apiKey));
    assert.ok(turn.events?.every(event => event.startedAt && event.finishedAt)); validateEvents(turn.events);
  } finally { reply.resolve(); execute.resolve(); await f.cleanup(); }
});
test('cancelling an awaited model reply closes running timeline entries and retains completed operations', async () => {
  const f = await fixture(async () => proposal);
  const model = new ResponsesModel(configuration, async (_url, options) => new Promise((_resolve, reject) => {
    options!.signal!.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
  }));
  f.provider.generate = (input, signal, access) => model.generate(input, signal, access);
  try {
    await f.send(); await until(f, turn => turn.events?.[0]?.status === 'running');
    await f.api.execute({ operation: 'cancel', projectId: f.project.definition.id, sessionId: f.session.id });
    const turn = (await f.get()).turns[0]; assert.equal(turn.status, 'cancelled'); assert.equal(turn.events?.[0].status, 'cancelled');
    assert.ok(turn.events?.[0].finishedAt);
  } finally { await f.cleanup(); }
});
test('timeline payloads and record counts remain bounded and invalid disk records are rejected', () => {
  const turn = { events: [] } as unknown as DevelopmentTurn;
  for (let index = 0; index < 160; index++) recordEvent(turn, { id: `event-${index}`, kind: 'tool', label: '读取文件', status: 'completed', output: '字'.repeat(30000) });
  assert.equal(turn.events!.length, 128); assert.ok(turn.events![0].output!.endsWith('…（内容已截断）')); validateEvents(turn.events);
  assert.throws(() => validateEvents([{ id: 'invalid', kind: 'shell', label: 'invalid', status: 'running' }]));
  assert.throws(() => validateEvents([turn.events![0], turn.events![0]]));
  assert.throws(() => validateEvents([{ ...turn.events![0], output: 'x'.repeat(9000) }]));
});
