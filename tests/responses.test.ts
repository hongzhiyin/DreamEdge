import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ResponsesModel } from '../desktop/development/responses';
import type { ModelInput } from '../desktop/development/model';
import { createDefinition } from '../desktop/workspace/definition';
import { proposal } from './development-fixture';

const input: ModelInput = { prompt: 'Change greeting', context: { definition: createDefinition('HelloWorld'),
  files: [{ path: 'main.ts', content: 'HelloWorld', hash: 'a'.repeat(64) }] }, history: [] };
const success = { status: 'completed', output: [{ type: 'reasoning' },
  { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(proposal) }] }] };
const configuration = { apiKey: 'fixture-private-key', model: 'fixture-model', baseUrl: 'https://model.example/v1/' };
test('Responses transport sends only scoped context and schema, with credentials confined to the Authorization header', async () => {
  const transport: typeof fetch = async (url, options) => {
    assert.equal(url, 'https://model.example/v1/responses');
    assert.equal(options!.redirect, 'error');
    assert.equal(new Headers(options!.headers).get('Authorization'), 'Bearer fixture-private-key');
    const body = JSON.parse(String(options!.body));
    assert.equal(body.model, configuration.model); assert.equal(body.store, false);
    assert.deepEqual(body.tools, []); assert.equal(body.text.format.strict, true);
    assert.ok(body.input.includes('main.ts')); assert.ok(!JSON.stringify(body).includes(configuration.apiKey));
    return Response.json(success);
  };
  const model = new ResponsesModel(configuration, transport);
  assert.equal((await model.connection()).available, true);
  assert.ok(!JSON.stringify(await model.connection()).includes(configuration.apiKey));
  assert.deepEqual(await model.generate(input, new AbortController().signal), proposal);
});
test('missing configuration and unsafe endpoints fail before transmitting credentials', async () => {
  let calls = 0;
  const transport: typeof fetch = async () => { calls++; return Response.json(success); };
  for (const config of [{}, { apiKey: 'key' }, { ...configuration, baseUrl: 'http://model.example/v1' },
    { ...configuration, baseUrl: 'https://user:password@model.example' },
    { ...configuration, baseUrl: 'https://model.example?secret=value' }, { ...configuration, baseUrl: 'invalid' }]) {
    const model = new ResponsesModel(config, transport);
    assert.equal((await model.connection()).available, false);
    await assert.rejects(model.generate(input, new AbortController().signal));
  }
  assert.equal(calls, 0);
});
test('HTTP errors, incomplete replies, refusal, malformed and oversized output do not become proposals', async () => {
  const results = [new Response('upstream-private-key', { status: 401 }),
    Response.json({ ...success, status: 'incomplete' }),
    Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', text: 'secret' }] }] }),
    Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'invalid' }] }] }),
    new Response('x'.repeat(1048577)), new Response('private-key-not-json')];
  for (const response of results) {
    const model = new ResponsesModel(configuration, async () => response);
    await assert.rejects(model.generate(input, new AbortController().signal), error => {
      assert.ok(!String(error).includes('private-key')); assert.ok(!String(error).includes('secret')); return true;
    });
  }
});
test('network failures are redacted and cancellation is passed to the transport', async () => {
  const controller = new AbortController();
  const model = new ResponsesModel(configuration, async (_url, options) => {
    assert.equal(options!.signal, controller.signal);
    throw new Error('fixture-private-key in network diagnostics');
  });
  await assert.rejects(model.generate(input, controller.signal), /无法连接模型服务/);
});
