import assert from 'node:assert/strict';
import test from 'node:test';
import { ConversationService } from '../src/index.js';
import { prepareContext } from '../src/model/context.js';
import { ControlledRun, startPending } from './helpers/conversation.js';
import { toolConversation, toolStoreFixture } from './helpers/tool-storage.js';

test('a new question replays full native tool history after SQLite restart', async t => {
  const f = await toolStoreFixture(t);
  const data = toolConversation(); f.store.save(data, null);
  const calls: ControlledRun[] = [];
  const service = new ConversationService({ store: f.store, connection: () => data.runs[0]!.modelConfigSnapshot,
    runtime: () => ({ start(request, observer) {
      const run = new ControlledRun(request, observer); calls.push(run); return { cancel() {}, done: run.done };
    } }) });
  t.after(async () => { for (const call of calls) call.finish('cancelled'); await service.dispose().catch(() => {}); });
  const handle = service.send({ sessionId: 's', clientMessageId: 'follow', text: 'what happened?' });
  await startPending();
  const request = calls[0]!.request;
  assert.deepEqual(request.messages.map(message => message.role), ['user', 'assistant', 'toolResult', 'assistant', 'user']);
  assert.deepEqual(request.messages.slice(1, 4), data.runs[0]!.transcript.map(entry => entry.message));
  assert.deepEqual(prepareContext(request), request.messages);
  calls[0]!.finish(); await handle.done;
});

test('model-only retry starts from saved results, retaining successes across later retries', async t => {
  const f = await toolStoreFixture(t);
  const data = toolConversation(); const previous = data.runs[0]!;
  previous.status = 'failed'; previous.transcript = previous.transcript.slice(0, 2);
  delete previous.nativeMessage; previous.text = 'incomplete';
  previous.error = { code: 'REQUEST_FAILED', message: 'fixture' };
  f.store.save(data, null);
  const calls: ControlledRun[] = [];
  const service = new ConversationService({ store: f.store, connection: () => previous.modelConfigSnapshot,
    runtime: () => ({ start(request, observer) {
      const run = new ControlledRun(request, observer); calls.push(run); return { cancel() {}, done: run.done };
    } }) });
  t.after(async () => { for (const call of calls) call.finish('cancelled'); await service.dispose().catch(() => {}); });
  const retry = service.retry('s', 'r'); await startPending();
  assert.equal(calls[0]!.request.continuation, true);
  assert.deepEqual(calls[0]!.request.messages.map(message => message.role), ['user', 'assistant', 'toolResult']);
  assert.deepEqual(prepareContext(calls[0]!.request), calls[0]!.request.messages);
  calls[0]!.finish(); await retry.done;
  const next = service.send({ sessionId: 's', clientMessageId: 'next', text: 'continue' }); await startPending();
  assert.equal(calls[1]!.request.messages.filter(message => message.role === 'toolResult').length, 1);
  assert.ok(!JSON.stringify(calls[1]!.request.messages).includes('incomplete'));
  calls[1]!.finish(); await next.done;
});

test('context rejects unmatched results and incomplete batches rather than repairing requests silently', () => {
  const data = toolConversation(); const trace = data.runs[0]!.transcript.map(entry => entry.message);
  const user = { role: 'user' as const, content: 'follow', timestamp: 140 };
  for (const messages of [[trace[1]!, user], [trace[0]!, user], [trace[0]!, trace[1]!, trace[1]!, user]]) {
    assert.throws(() => prepareContext({ sessionId: 's', runId: 'new', messages }), { code: 'INVALID_CONTEXT' });
  }
});

test('native tool declarations survive storage and enter context with their original parameters', async t => {
  const f = await toolStoreFixture(t); const data = toolConversation(); const run = data.runs[0]!;
  const definition = run.toolsSnapshot[0]!;
  run.transcript = [{ sessionId: 's', runId: 'r', turnId: 'setup', messageId: 'setup', ordinal: 0,
    message: { role: 'system', content: 'Tool definitions', timestamp: 100, toolsAdded: [{ name: definition.name,
      description: definition.description, parameters: definition.parameters }] } },
    ...run.transcript.map(entry => ({ ...entry, ordinal: entry.ordinal + 1 }))];
  f.store.save(data, null);
  const restored = f.store.load()[0]!.runs[0]!;
  assert.deepEqual(restored.transcript, run.transcript);
  assert.doesNotThrow(() => prepareContext({ sessionId: 's', runId: 'next',
    messages: [data.messages[0]!, ...restored.transcript!.map(entry => entry.message),
      { role: 'user', content: 'next', timestamp: 140 }] }));
});
