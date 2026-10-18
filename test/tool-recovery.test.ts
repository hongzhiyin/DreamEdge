import assert from 'node:assert/strict';
import test from 'node:test';
import { ConversationService } from '../src/index.js';
import { prepareContext } from '../src/model/context.js';
import { ControlledRun, startPending } from './helpers/conversation.js';
import { pendingConversation, toolStoreFixture } from './helpers/tool-storage.js';

for (const phase of ['read', 'write', 'approval'] as const) {
  test(`tool recovery: ${phase} restores truthful error results without dispatch or reauthorization`, async t => {
    const f = await toolStoreFixture(t);
    const data = pendingConversation(phase === 'read' ? 'read' : 'write', phase === 'approval');
    f.store.save(data, null); f.store.close();
    const calls: ControlledRun[] = [];
    const store = f.open();
    const service = new ConversationService({ store, now: () => 200, connection: () => data.runs[0]!.modelConfigSnapshot,
      runtime: () => ({ start(request, observer) {
        const run = new ControlledRun(request, observer); calls.push(run); return { cancel() {}, done: run.done };
      } }) });
    t.after(async () => { for (const call of calls) call.finish('cancelled'); await service.dispose().catch(() => {}); });
    const run = service.getSnapshot('s').runs[0]!;
    assert.equal(run.status, 'interrupted');
    assert.equal(run.toolCalls![0]!.status, phase === 'write' ? 'outcome_unknown' : 'interrupted');
    assert.equal(run.transcript!.at(-1)!.message.role, 'toolResult');
    if (phase === 'approval') assert.equal(run.approvals![0]!.status, 'cancelled');
    assert.equal(calls.length, 0);
    assert.deepEqual(store.load()[0]!.runs[0], run);
    const handle = service.send({ sessionId: 's', clientMessageId: 'follow', text: 'what happened?' }); await startPending();
    const context = calls[0]!.request;
    assert.deepEqual(context.messages.map(message => message.role), ['user', 'assistant', 'toolResult', 'system', 'user']);
    assert.deepEqual(prepareContext(context), context.messages);
    assert.ok(JSON.stringify(context.messages).includes(phase === 'write' ? 'OUTCOME_UNKNOWN' : 'INTERRUPTED'));
    calls[0]!.finish(); await handle.done;
  });
}
