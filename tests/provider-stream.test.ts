import assert from 'node:assert/strict';
import { test } from 'node:test';
import { guardedResponse } from '../desktop/development/provider-stream';
import { ResponsesModel } from '../desktop/development/responses';
import { fixture, deferred } from './development-fixture';

const encode = (value: unknown) => new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`);
test('guarded transport forwards SSE before EOF while preventing credentials split across chunks', async () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const source = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
  const key = 'private-model-secret';
  const response = guardedResponse(new Response(source), key, new AbortController().signal); const reader = response.body!.getReader();
  controller.enqueue(new TextEncoder().encode('data: first\n\n'));
  assert.equal(new TextDecoder().decode((await reader.read()).value), 'data: first\n\n');
  controller.enqueue(new TextEncoder().encode('data: private-model-'));
  assert.equal(new TextDecoder().decode((await reader.read()).value), 'data: ');
  controller.enqueue(new TextEncoder().encode('secret\n\n'));
  await assert.rejects(reader.read(), error => /凭据/.test(String(error)) && !String(error).includes(key));
});
test('provider thinking summary arrives in the timeline while the same SSE response is still open', async () => {
  const f = await fixture(async () => ({})); const finish = deferred<void>(); const ready = deferred<void>();
  const configuration = { apiKey: 'fixture-stream-key', model: 'test', baseUrl: 'https://model.example/v1' };
  const model = new ResponsesModel(configuration, async () => {
    const item = { id: 'reason', type: 'reasoning', summary: [{ type: 'summary_text', text: '正在核对页面结构。' }] };
    return new Response(new ReadableStream<Uint8Array>({ async start(controller) {
      controller.enqueue(encode({ type: 'response.created', response: { id: 'resp', status: 'in_progress' } }));
      controller.enqueue(encode({ type: 'response.output_item.added', output_index: 0, item }));
      controller.enqueue(encode({ type: 'response.output_item.done', output_index: 0, item }));
      ready.resolve(); await finish.promise;
      const tool = { id: 'fc_submit', type: 'function_call', call_id: 'submit', name: 'propose_changes', arguments: '{"summary":"Done","files":[]}' };
      for (const event of [
        { type: 'response.output_item.added', output_index: 1, item: { ...tool, arguments: '' } },
        { type: 'response.output_item.done', output_index: 1, item: tool },
        { type: 'response.completed', response: { id: 'resp', status: 'completed', output: [item, tool] } },
      ]) controller.enqueue(encode(event)); controller.close();
    } }), { headers: { 'Content-Type': 'text/event-stream' } });
  });
  f.provider.generate = (input, signal, access) => model.generate(input, signal, access);
  try {
    await f.send(); await ready.promise; const deadline = Date.now() + 2000;
    while (!(await f.get()).turns[0].events?.some(event => event.kind === 'thinking') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    const turn = (await f.get()).turns[0]; assert.equal(turn.status, 'running');
    assert.equal(turn.events?.find(event => event.kind === 'thinking')?.content, '正在核对页面结构。');
    finish.resolve(); assert.equal((await f.settled()).turns[0].status, 'completed');
  } finally { finish.resolve(); await f.cleanup(); }
});
