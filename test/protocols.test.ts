import assert from 'node:assert/strict';
import test from 'node:test';
import { PiRuntime } from '../src/index.js';
import type { ModelProtocol, RuntimeEvent } from '../src/index.js';
import { anthropicReply, googleReply, responsesReply } from './helpers/protocol-replies.js';
import { beginSse, chatChunk, chatReply, connection, modelServer, request } from './helpers/server.js';

for (const [protocol, reply] of [
  ['openai-responses', responsesReply], ['anthropic-messages', anthropicReply],
  ['google-generative-ai', googleReply],
] as const) {
  test(`${protocol}: native Pi adapter decodes HTTP stream and forwards configured model`, async t => {
    const server = await modelServer(response => reply(response));
    t.after(() => server.close());
    const { reasoning: unused, ...base } = connection(server.baseUrl);
    const events: RuntimeEvent[] = [];
    const result = await new PiRuntime({ ...base, protocol: protocol as ModelProtocol }, async () => 'fixture-key')
      .start(request(), event => { events.push(event); }).done;
    assert.equal(result.status, 'completed', result.error?.message);
    assert.equal(result.text, 'Hello world');
    assert.equal(result.thinkingLevel, 'off');
    assert.equal(server.requests.length, 1);
    assert.ok(events.some(event => event.type === 'delta' && event.channel === 'text'));
    const started = events.find(event => event.type === 'started');
    assert.ok(started?.type === 'started' && started.notices.length === 1);
  });
}

test('serialized native DeepSeek assistant replays reasoning without duplicating the final user input', async t => {
  const server = await modelServer(response => chatReply(response));
  t.after(() => server.close());
  const runtime = new PiRuntime(connection(server.baseUrl), async () => 'fixture-key');
  const first = await runtime.start(request()).done;
  assert.ok(first.message);
  const restored = JSON.parse(JSON.stringify(first.message)) as typeof first.message;
  const second = await runtime.start({ sessionId: 'session-one', runId: 'run-two',
    messages: [...request().messages, restored, { role: 'user', content: 'Follow up', timestamp: 3 }] }).done;
  assert.equal(second.status, 'completed');
  const wire = server.requests[1]!.body.messages as { role: string; content: string; reasoning_content?: string }[];
  assert.equal(wire.filter(message => message.content === 'Follow up').length, 1);
  assert.equal(wire.find(message => message.role === 'assistant')?.reasoning_content, 'fixture reasoning');
});

test('unexpected tool call is failed and cannot trigger another provider request', async t => {
  const server = await modelServer(response => {
    beginSse(response);
    chatChunk(response, { tool_calls: [{ index: 0, id: 'tool-one', type: 'function',
      function: { name: 'read_file', arguments: '{"path":"private"}' } }] });
    chatChunk(response, {}, 'tool_calls');
    response.end('data: [DONE]\n\n');
  });
  t.after(() => server.close());
  const result = await new PiRuntime(connection(server.baseUrl), async () => 'fixture-key').start(request()).done;
  assert.equal(result.status, 'failed');
  assert.equal(result.error?.code, 'UNEXPECTED_RESPONSE');
  assert.equal(server.requests.length, 1);
});
