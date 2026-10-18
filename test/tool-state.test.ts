import assert from 'node:assert/strict';
import test from 'node:test';
import { assertToolTransition, isPendingApprovalFor, ToolContractError } from '../src/index.js';
import type { ApprovalRecord, ToolCallRecord, ToolCallStatus } from '../src/index.js';

const base = { sessionId: 'session', runId: 'run', turnId: 'turn', toolCallId: 'call',
  toolName: 'fixture', toolVersion: '1', args: {}, argsDigest: 'digest', createdAt: 100,
  effect: 'read' as const, approval: 'never' as const };

test('tool lifecycle keeps terminal states terminal and distinguishes uncertain writes', () => {
  const requested: ToolCallRecord = { ...base, status: 'requested' };
  assertToolTransition(requested, 'running');
  assert.throws(() => assertToolTransition(requested, 'succeeded'), ToolContractError);
  assert.throws(() => assertToolTransition({ ...requested, approval: 'always' }, 'running'), ToolContractError);
  assertToolTransition({ ...base, approval: 'always', status: 'awaiting_approval', approvalId: 'approval' }, 'running');
  const running: ToolCallRecord = { ...base, status: 'running', startedAt: 110 };
  assertToolTransition(running, 'succeeded'); assertToolTransition(running, 'interrupted');
  assert.throws(() => assertToolTransition(running, 'outcome_unknown'), ToolContractError);
  assertToolTransition({ ...running, effect: 'write', approval: 'always' }, 'outcome_unknown');
  assert.throws(() => assertToolTransition({ ...running, effect: 'write' }, 'interrupted'), ToolContractError);
  const terminal: ToolCallRecord = { ...base, status: 'succeeded', startedAt: 110, finishedAt: 120, result: { content: [] } };
  for (const state of ['running', 'succeeded', 'failed', 'cancelled', 'interrupted', 'outcome_unknown'] as ToolCallStatus[]) {
    assert.throws(() => assertToolTransition(terminal, state), ToolContractError);
  }
});

test('approval matching binds the full call target, time window and pending state', () => {
  const approval: ApprovalRecord = { ...base, approvalId: 'approval', summary: '写入隔离记录',
    resources: ['fixture:record'], status: 'pending', expiresAt: 200 };
  assert.equal(isPendingApprovalFor(approval, base, 150), true);
  for (const key of ['sessionId', 'runId', 'turnId', 'toolCallId', 'toolName', 'toolVersion', 'argsDigest']) {
    assert.equal(isPendingApprovalFor(approval, { ...base, [key]: 'other' }, 150), false);
  }
  for (const now of [99, 200, Infinity, NaN]) assert.equal(isPendingApprovalFor(approval, base, now), false);
  assert.equal(isPendingApprovalFor({ ...approval, status: 'approved', decidedAt: 120 }, base, 150), false);
  assert.equal(isPendingApprovalFor({ ...approval, expiresAt: Infinity }, base, 150), false);
});
