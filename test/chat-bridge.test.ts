import assert from 'node:assert/strict';
import test from 'node:test';
import { ChatHub } from '../src/chat/hub.js';
import { ChatJournal } from '../src/chat/journal.js';
import { newerFrame } from '../src/chat/replica.js';
import { isSubmitKey } from '../src/chat/input.js';
import type { ChatEvent, ChatView } from '../src/chat/types.js';
import { conversationFixture, startPending } from './helpers/conversation.js';

const view = (text: string): ChatView => ({ sessionId: 'session', title: text, updatedAt: 1,
  messages: [], acceptingCommands: true, saving: { status: 'saved' } });

test('bounded chat journal replays recent updates and falls back to a full snapshot after gaps', () => {
  const journal = new ChatJournal(2);
  const first = journal.publish(view('one'))!;
  const second = journal.publish(view('two'))!;
  assert.deepEqual(journal.catchup(first), { kind: 'replay', events: [second] });
  const third = journal.publish(view('three'))!;
  const fourth = journal.publish(view('four'))!;
  assert.deepEqual(journal.catchup(first), { kind: 'snapshot', event: fourth });
  assert.deepEqual(journal.catchup(second), { kind: 'replay', events: [third, fourth] });
  assert.deepEqual(journal.catchup(fourth), { kind: 'replay', events: [] });
  assert.equal(journal.catchup({ epoch: 'old-host', sequence: 999 }).kind, 'snapshot');
});

test('journal outputs are detached and unchanged views do not produce duplicate updates', () => {
  const journal = new ChatJournal(2);
  const source = view('one'); const event = journal.publish(source)!;
  source.title = 'changed caller'; event.view.title = 'changed receiver';
  const result = journal.catchup();
  assert.ok(result.kind === 'snapshot'); assert.equal(result.event.view.title, 'one');
  result.event.view.title = 'another mutation';
  assert.equal(journal.publish(view('one')), undefined);
});

test('late replay and snapshot replies cannot roll back newer renderer state', () => {
  const first: ChatEvent = { sessionId: 'session', epoch: 'host', sequence: 1, view: view('one') };
  const latest = { ...first, sequence: 3, view: view('latest') };
  assert.equal(newerFrame(latest, first, true), false);
  assert.equal(newerFrame(latest, latest), false);
  assert.equal(newerFrame(first, latest), true);
  const restarted = { ...first, epoch: 'new-host' };
  assert.equal(newerFrame(latest, restarted), false);
  assert.equal(newerFrame(latest, restarted, true), true);
  assert.equal(newerFrame(latest, { ...latest, sessionId: 'other' }), false);
});

test('chat bridge accepts only bounded chat commands and exposes no privileged payloads', async () => {
  const { service, config, create, calls } = conversationFixture();
  const hub = new ChatHub(service, config); const sessionId = create();
  for (const command of [{ type: 'readFile', path: '/private' }, { type: 'initialize', credentials: true },
    { type: 'watch', sessionId, cursor: { epoch: 'host', sequence: -1 } },
    { type: 'send', input: { sessionId, clientMessageId: 'one', text: 'x', apiKey: 'secret' } }]) {
    assert.deepEqual(hub.execute(command), { ok: false, error: { code: 'INVALID_COMMAND', message: '聊天命令无效。' } });
  }
  const initial = hub.execute({ type: 'initialize' }); assert.ok(initial.ok);
  assert.ok(!JSON.stringify(initial).includes('credentialRef'));
  const reply = hub.execute({ type: 'send', input: { sessionId, clientMessageId: 'one', text: 'question' } });
  assert.ok(reply.ok); await startPending(); calls[0]!.finish();
  await service.send({ sessionId, clientMessageId: 'one', text: 'question' }).done;
  const snapshot = hub.execute({ type: 'watch', sessionId }); assert.ok(snapshot.ok);
  assert.ok(!JSON.stringify(snapshot).includes('nativeMessage'));
  assert.ok(!JSON.stringify(snapshot).includes('native-signature'));
  hub.dispose(); await service.dispose();
});

test('observer errors and detached chat windows do not stop host generation', async () => {
  const { service, config, create, calls } = conversationFixture();
  const hub = new ChatHub(service, config); const sessionId = create();
  const detach = service.subscribe(() => { throw new Error('disconnected view'); });
  const handle = service.send({ sessionId, clientMessageId: 'one', text: 'question' });
  await startPending(); await calls[0]!.emit(1, 'partial');
  calls[0]!.finish('completed', 'partial complete');
  assert.equal((await handle.done).status, 'completed');
  assert.equal((hub.execute({ type: 'watch', sessionId })).ok, true);
  detach(); hub.dispose(); await service.dispose();
});

test('IME confirmation, legacy keycode and composition-end Enter never submit accidentally', () => {
  const enter = { key: 'Enter', shiftKey: false, isComposing: false, keyCode: 13 };
  assert.equal(isSubmitKey({ ...enter, isComposing: true }, false, -Infinity, 100), false);
  assert.equal(isSubmitKey(enter, true, -Infinity, 100), false);
  assert.equal(isSubmitKey({ ...enter, keyCode: 229 }, false, -Infinity, 100), false);
  assert.equal(isSubmitKey(enter, false, 100, 125), false);
  assert.equal(isSubmitKey(enter, false, 100, 200), true);
  assert.equal(isSubmitKey({ ...enter, shiftKey: true }, false, -Infinity, 100), false);
});
