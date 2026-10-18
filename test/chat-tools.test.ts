import assert from 'node:assert/strict';
import test from 'node:test';
import { chatView } from '../src/chat/projection.js';
import { toolTimeline } from '../src/chat/tool-projection.js';
import { toolConversation } from './helpers/tool-storage.js';

test('chat projects model turns and each tool once, including arguments and actual results', () => {
  const fixture = toolConversation('write');
  const view = chatView({ ...fixture, saveState: { status: 'saved', savedVersion: 1 }, acceptingCommands: true });
  const attempt = view.messages[0]!.attempts[0]!;
  assert.deepEqual(attempt.timeline!.map(item => item.kind), ['model', 'tool', 'model']);
  const tool = attempt.timeline![1]!; assert.ok(tool.kind === 'tool');
  assert.equal(tool.call.label, '隔离工具'); assert.deepEqual(tool.call.args, { amount: 3 });
  assert.equal(tool.call.result!.content[0]!.type, 'text'); assert.equal(tool.call.approval!.status, 'approved');
  assert.ok(!JSON.stringify(view).includes('native reasoning signature'));
  for (const field of ['credentialRef', 'modelConfigSnapshot', 'thoughtSignature', 'parameters', 'execute']) {
    assert.ok(!JSON.stringify(view).includes(`"${field}"`));
  }
  tool.call.args.amount = 999; assert.equal(fixture.runs[0]!.toolCalls[0]!.args.amount, 3);
});

test('streaming turn is shown once and reconciles with the sealed native message', () => {
  const run = toolConversation().runs[0]!;
  run.status = 'running'; run.transcript = run.transcript.slice(0, 2);
  run.currentMessageId = 'm3'; run.currentTurnId = 'turn-2'; run.text = 'stream'; run.thinking = 'live reasoning';
  let timeline = toolTimeline(run); assert.equal(timeline.length, 3);
  assert.deepEqual(timeline.at(-1), { kind: 'model', messageId: 'm3', turnId: 'turn-2', text: 'stream', thinking: 'live reasoning' });
  run.transcript = toolConversation().runs[0]!.transcript;
  timeline = toolTimeline(run); assert.equal(timeline.length, 3); assert.equal(timeline.at(-1)?.kind, 'model');
  assert.ok(!JSON.stringify(timeline).includes('stream'));
});

test('unknown write from an earlier attempt blocks retry on the whole question', () => {
  const fixture = toolConversation('write'); const first = fixture.runs[0]!;
  const call = first.toolCalls[0]!;
  first.toolCalls = [{ ...call, status: 'outcome_unknown', startedAt: 110, finishedAt: 120,
    error: { code: 'OUTCOME_UNKNOWN', message: 'unknown' } }];
  fixture.runs.push({ ...first, runId: 'later', toolCalls: [], approvals: [], transcript: [], status: 'failed' });
  const view = chatView({ ...fixture, saveState: { status: 'saved', savedVersion: 1 }, acceptingCommands: true });
  assert.ok(view.messages[0]!.attempts.every(attempt => attempt.retryBlocked));
});

test('partial streamed text survives a synthetic empty failure message in the public timeline', () => {
  const run = toolConversation().runs[0]!; const final = run.transcript[2]!;
  run.transcript = [...run.transcript.slice(0, 2), { ...final, message: { ...final.message,
    role: 'assistant', content: [], stopReason: 'aborted' } as Extract<typeof final.message, { role: 'assistant' }> }];
  run.currentMessageId = final.messageId; run.currentTurnId = final.turnId; run.text = 'partial reply'; run.thinking = 'partial reasoning';
  const timeline = toolTimeline(run); assert.ok(timeline.at(-1)?.kind === 'model');
  assert.equal((timeline.at(-1) as { text: string }).text, 'partial reply');
});
