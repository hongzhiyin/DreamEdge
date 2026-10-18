import assert from 'node:assert/strict';
import test from 'node:test';
import { ConversationService, PiRuntime } from '../src/index.js';
import { conversationFixture, startPending } from './helpers/conversation.js';
import { chatReply, connection, deadline, modelServer } from './helpers/server.js';

test('sessions build isolated multi-turn context and preserve native assistant fields', async () => {
  const { service, calls, create } = conversationFixture();
  const firstSession = create();
  const otherSession = create();
  const first = service.send({ sessionId: firstSession, clientMessageId: 'one', text: 'code amber' });
  await startPending();
  calls[0]!.finish('completed', 'remember amber');
  await first.done;
  const second = service.send({ sessionId: firstSession, clientMessageId: 'two', text: 'what code?' });
  const independent = service.send({ sessionId: otherSession, clientMessageId: 'one', text: 'what code?' });
  await startPending();
  const messages = calls[1]!.request.messages;
  assert.deepEqual(messages.map(message => message.role), ['user', 'assistant', 'user']);
  assert.equal(messages.filter(message => message.content === 'what code?').length, 1);
  const native = messages[1];
  assert.ok(native?.role === 'assistant');
  assert.equal(native.content[0]?.type === 'thinking' && native.content[0].thinkingSignature, 'native-signature');
  assert.equal(calls[2]!.request.messages.length, 1);
  calls[1]!.finish(); calls[2]!.finish();
  await Promise.all([second.done, independent.done]);
});

test('retry reuses the question, snapshots model parameters and excludes incomplete turns', async () => {
  const { service, calls, config, create } = conversationFixture();
  const sessionId = create();
  const failed = service.send({ sessionId, clientMessageId: 'one', text: 'question', thinkingLevel: 'low' });
  await startPending(); calls[0]!.finish('failed', 'partial failure'); await failed.done;
  config.model = 'changed-model';
  const retry = service.retry(sessionId);
  assert.notEqual(retry.runId, failed.runId);
  assert.equal(retry.userMessageId, failed.userMessageId);
  await startPending();
  assert.equal(calls[1]!.request.messages.length, 1);
  calls[1]!.finish('completed', 'successful answer'); await retry.done;
  const snapshot = service.getSnapshot(sessionId);
  assert.equal(snapshot.messages.length, 1);
  assert.equal(snapshot.runs.length, 2);
  assert.equal(snapshot.runs[1]!.modelConfigSnapshot.model, 'fixture-model');
  assert.equal(snapshot.runs[1]!.modelConfigSnapshot.thinkingLevel, 'low');
  const next = service.send({ sessionId, clientMessageId: 'two', text: 'follow up' });
  await startPending();
  const history = calls[2]!.request.messages;
  assert.equal(history.length, 3);
  assert.ok(!JSON.stringify(history).includes('partial failure'));
  assert.ok(JSON.stringify(history).includes('successful answer'));
  calls[2]!.finish(); await next.done;
  assert.throws(() => service.retry(sessionId), { code: 'RETRY_UNAVAILABLE' });
});

test('abandoned failed and cancelled turns stay in records but do not become model history', async () => {
  const { service, calls, create } = conversationFixture();
  const sessionId = create();
  for (const [i, status] of (['failed', 'cancelled'] as const).entries()) {
    const handle = service.send({ sessionId, clientMessageId: String(i), text: `abandoned ${i}` });
    await startPending(); calls[i]!.finish(status, `partial ${i}`); await handle.done;
  }
  const next = service.send({ sessionId, clientMessageId: 'next', text: 'new question' });
  await startPending();
  assert.deepEqual(calls[2]!.request.messages.map(message => message.content), ['new question']);
  const snapshot = service.getSnapshot(sessionId);
  assert.equal(snapshot.messages.length, 3);
  assert.deepEqual(snapshot.runs.slice(0, 2).map(run => run.text), ['partial 0', 'partial 1']);
  calls[2]!.finish(); await next.done;
});

test('caller mutations cannot alter session records, command deduplication or future context', async () => {
  const { service, calls, config, create } = conversationFixture();
  const sessionId = create();
  const input = { sessionId, clientMessageId: 'one', text: 'original question' };
  const handle = service.send(input);
  input.text = 'mutated'; config.model = 'mutated model';
  await startPending();
  const native = calls[0]!.finish('completed', 'original answer');
  const final = await handle.done;
  native.message!.content = []; final.text = 'mutated';
  const snapshot = service.getSnapshot(sessionId);
  snapshot.messages[0]!.content = 'changed'; snapshot.runs[0]!.nativeMessage!.content = [];
  snapshot.session.title = 'changed'; service.listSessions()[0]!.title = 'also changed';
  assert.equal(service.send({ sessionId, clientMessageId: 'one', text: 'original question' }), handle);
  assert.equal(service.getSnapshot(sessionId).runs[0]!.modelConfigSnapshot.model, 'fixture-model');
  const next = service.send({ sessionId, clientMessageId: 'two', text: 'follow up' });
  await startPending();
  assert.equal(calls[1]!.request.messages[0]!.content, 'original question');
  assert.ok(JSON.stringify(calls[1]!.request.messages).includes('original answer'));
  calls[1]!.finish(); await next.done;
  assert.equal(service.getSnapshot(sessionId).session.title, '新对话');
});

test('ConversationService and PiRuntime replay DeepSeek reasoning over HTTP without duplicate questions', async t => {
  const server = await modelServer(response => chatReply(response));
  t.after(() => server.close());
  const config = connection(server.baseUrl);
  const service = new ConversationService({ connection: () => config,
    runtime: snapshot => new PiRuntime(snapshot, async () => 'fixture-key') });
  t.after(() => service.dispose());
  const session = service.createSession({ connectionId: 'fixture', systemPrompt: 'Be concise.' });
  for (const [i, text] of ['random code amber', 'what code?', 'repeat it'].entries()) {
    const run = await deadline(service.send({ sessionId: session.sessionId, clientMessageId: String(i), text }).done);
    assert.equal(run.status, 'completed');
  }
  const wire = server.requests[2]!.body.messages as { role: string; content: string; reasoning_content?: string }[];
  assert.deepEqual(wire.map(message => message.role), ['system', 'user', 'assistant', 'user', 'assistant', 'user']);
  assert.equal(wire.filter(message => message.content === 'repeat it').length, 1);
  assert.equal(wire.find(message => message.role === 'assistant')?.reasoning_content, 'fixture reasoning');
  assert.equal(service.getSnapshot(session.sessionId).messages.length, 3);
});
