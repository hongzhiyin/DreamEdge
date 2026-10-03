import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ResponsesModel } from '../desktop/development/responses';
import { createDefinition } from '../desktop/workspace/definition';
import { providerResponse } from './provider-fixture';

const configuration = { apiKey: 'fixture-pi-secret', model: 'deepseek-flash', baseUrl: 'https://api.deepseek.com' };
const input = { prompt: 'Check', context: { definition: createDefinition('Check'), files: [] }, history: [] };
const access = { execute: async () => ({ accepted: true }), activity: async () => {} };
const submit = { type: 'function_call', call_id: 'submit', name: 'propose_changes', arguments: '{"summary":"OK","files":[]}' };
test('native pi provider requests SSE and preserves normal conversation roles across completed turns', async () => {
  const model = new ResponsesModel(configuration, async (_url, options) => {
    const body = JSON.parse(String(options!.body)); assert.equal(body.stream, true); assert.equal(body.store, false);
    assert.ok(body.input.some((item: any) => item.role === 'user' && JSON.stringify(item.content).includes('Earlier request')));
    assert.ok(body.input.some((item: any) => item.role === 'assistant'));
    return providerResponse([submit]);
  });
  assert.deepEqual(await model.generate({ ...input, history: [{ prompt: 'Earlier request', summary: 'Earlier reply', changes: [] }] }, new AbortController().signal, access), { summary: 'OK', files: [] });
});
test('pi refuses a stream with no terminal event and an unfinished tool call without executing either', async () => {
  let executions = 0;
  const unfinished = [
    { type: 'response.output_item.added', output_index: 0, item: { ...submit, id: 'fc_submit', arguments: '' } },
    { type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"summary":' },
  ];
  for (const events of [unfinished, [...unfinished, { type: 'response.completed', response: { status: 'completed', id: 'resp', output: [] } }]]) {
    const model = new ResponsesModel(configuration, async () => new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } }));
    await assert.rejects(model.generate(input, new AbortController().signal, { ...access, execute: async () => { executions++; return {}; } }));
  }
  assert.equal(executions, 0);
});
test('provider boundary retains authentication diagnostics and never forwards upstream credentials', async () => {
  const unauthorized = new ResponsesModel(configuration, async () => new Response(configuration.apiKey, { status: 401 }));
  await assert.rejects(unauthorized.generate(input, new AbortController().signal, access), error => /认证失败/.test(String(error)) && !String(error).includes(configuration.apiKey));
  const echoed = new ResponsesModel(configuration, async () => providerResponse([{ type: 'message', content: [{ type: 'output_text', text: configuration.apiKey }] }]));
  await assert.rejects(echoed.generate(input, new AbortController().signal, access), error => /凭据/.test(String(error)) && !String(error).includes(configuration.apiKey));
});
test('a length-limited native response cannot execute even a complete-looking proposal', async () => {
  let executions = 0;
  const model = new ResponsesModel(configuration, async () => providerResponse([submit], true));
  await assert.rejects(model.generate(input, new AbortController().signal, { ...access, execute: async () => { executions++; return {}; } }), /长度上限/);
  assert.equal(executions, 0);
});
test('a fatal tool-budget failure cannot accept an earlier proposal from the same batch', async () => {
  const output = [submit, ...Array.from({ length: 48 }, (_, index) => ({ type: 'function_call', call_id: `list${index}`,
    name: 'list_files', arguments: '{"directory":"","offset":0}' }))];
  const model = new ResponsesModel(configuration, async () => providerResponse(output));
  await assert.rejects(model.generate(input, new AbortController().signal, access), /工具调用上限/);
});
