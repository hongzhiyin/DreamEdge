import assert from 'node:assert/strict';
import test from 'node:test';
import { PiRuntime } from '../src/index.js';
import type { RuntimeEvent } from '../src/index.js';
import { beginSse, chatChunk, chatReply, connection, deadline, modelServer, request } from './helpers/server.js';

const credentials = async () => 'fixture-key';

test('DeepSeek-compatible wire request, stream, high thinking and native replay metadata', async t => {
  const server = await modelServer(response => chatReply(response));
  t.after(() => server.close());
  const runtime = new PiRuntime(connection(server.baseUrl), credentials);
  const input = request();
  const before = structuredClone(input);
  const events: RuntimeEvent[] = [];
  const result = await runtime.start(input, event => { events.push(event); }).done;
  assert.equal(result.status, 'completed');
  assert.equal(result.text, 'Hello world');
  assert.equal(result.thinkingLevel, 'high');
  assert.equal(result.message?.usage.totalTokens, 5);
  assert.ok(result.message?.content.some(block => block.type === 'thinking'));
  assert.deepEqual(input, before);
  assert.deepEqual(events.map(event => event.sequence), events.map((_, i) => i + 1));
  assert.equal(events[0]?.type, 'started');
  assert.equal(events.at(-1)?.type, 'settled');
  const captured = server.requests[0]!;
  assert.equal(captured.headers.authorization, 'Bearer fixture-key');
  assert.equal(captured.body.model, 'fixture-model');
  assert.equal(captured.body.reasoning_effort, 'high');
  assert.deepEqual(captured.body.thinking, { type: 'enabled' });
  assert.equal(captured.body.max_tokens, 8192);
  assert.equal(captured.body.tools, undefined);
  const wire = captured.body.messages as { role: string; content: string }[];
  assert.equal(wire.filter(message => message.role === 'user').length, 1);
});

test('output limit is a failed partial response, not successful completion', async t => {
  const server = await modelServer(response => chatReply(response, 'length'));
  t.after(() => server.close());
  const result = await new PiRuntime(connection(server.baseUrl), credentials).start(request()).done;
  assert.equal(result.status, 'failed');
  assert.equal(result.error?.code, 'OUTPUT_LIMIT');
  assert.equal(result.text, 'Hello world');
});

test('unfinished SSE response and HTTP authentication failure are not complete; errors redact credentials', async t => {
  const server = await modelServer((response, captured) => {
    if (captured.body.model === 'denied') {
      response.writeHead(401, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'denied fixture-key', type: 'authentication_error' } }));
    } else {
      beginSse(response); chatChunk(response, { content: 'Partial' }); response.end();
    }
  });
  t.after(() => server.close());
  const partial = await new PiRuntime(connection(server.baseUrl), credentials).start(request()).done;
  assert.equal(partial.status, 'failed');
  assert.equal(partial.text, 'Partial');
  const denied = await new PiRuntime(connection(server.baseUrl, { model: 'denied' }), credentials).start(request()).done;
  assert.equal(denied.status, 'failed');
  assert.ok(!JSON.stringify(denied).includes('fixture-key'));
  assert.equal(server.requests.length, 2, 'SDK must not silently retry');
});

test('cancel propagates to HTTP transport and settles with partial text', async t => {
  let closed!: () => void;
  const closure = new Promise<void>(resolve => { closed = resolve; });
  const server = await modelServer(response => {
    beginSse(response); chatChunk(response, { content: 'Partial' });
    response.once('close', closed);
  });
  t.after(() => server.close());
  const runtime = new PiRuntime(connection(server.baseUrl), credentials);
  const events: RuntimeEvent[] = [];
  const handle = runtime.start(request(), event => {
    events.push(event);
    if (event.type === 'delta' && event.channel === 'text') handle.cancel();
  });
  const result = await deadline(handle.done);
  await deadline(closure);
  assert.equal(result.status, 'cancelled');
  assert.equal(result.text, 'Partial');
  assert.equal(events.at(-1)?.type, 'settled');
});

test('done waits for final observer acknowledgment', async t => {
  const server = await modelServer(response => chatReply(response));
  t.after(() => server.close());
  let release!: () => void;
  let observed!: () => void;
  const finalSeen = new Promise<void>(resolve => { observed = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const handle = new PiRuntime(connection(server.baseUrl), credentials).start(request(), async event => {
    if (event.type === 'settled') { observed(); await gate; }
  });
  let complete = false;
  void handle.done.then(() => { complete = true; });
  await deadline(finalSeen);
  assert.equal(complete, false);
  release();
  assert.equal((await handle.done).status, 'completed');
});

test('observer failure aborts the request and preserves partial text', async t => {
  const server = await modelServer(response => {
    beginSse(response); chatChunk(response, { content: 'Partial' });
  });
  t.after(() => server.close());
  const result = await deadline(new PiRuntime(connection(server.baseUrl), credentials).start(request(), event => {
    if (event.type === 'delta') throw new Error('observer failed');
  }).done);
  assert.equal(result.status, 'failed');
  assert.equal(result.error?.code, 'EVENT_DELIVERY_FAILED');
  assert.equal(result.text, 'Partial');
});

test('request timeout has a distinct failure state', async t => {
  const server = await modelServer(response => { beginSse(response); chatChunk(response, { role: 'assistant' }); });
  t.after(() => server.close());
  const result = await deadline(new PiRuntime(connection(server.baseUrl, { timeoutMs: 100 }), credentials)
    .start(request()).done);
  assert.equal(result.status, 'failed');
  assert.equal(result.error?.code, 'REQUEST_TIMEOUT');
});

test('run identity and final result are isolated from caller and observer mutations', async t => {
  const server = await modelServer(response => chatReply(response));
  t.after(() => server.close());
  let resolveKey!: (key: string) => void;
  const key = new Promise<string>(resolve => { resolveKey = resolve; });
  const input = request();
  const events: RuntimeEvent[] = [];
  const runtime = new PiRuntime(connection(server.baseUrl), () => key);
  const handle = runtime.start(input, event => {
    events.push(event);
    if (event.type === 'settled') event.result.status = 'failed';
  });
  input.sessionId = 'changed-session';
  input.runId = 'changed-run';
  resolveKey('fixture-key');
  const result = await handle.done;
  assert.equal(result.sessionId, 'session-one');
  assert.equal(result.runId, 'run-one');
  assert.equal(result.status, 'completed');
  assert.ok(events.every(event => event.sessionId === 'session-one' && event.runId === 'run-one'));
});
