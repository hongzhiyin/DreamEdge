import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { Type } from 'typebox';
import { SqliteSessionStore, toolSnapshot, argumentsDigest } from '../../src/index.js';
import type { StoredConversation, ToolRunRecord, ToolCallRecord } from '../../src/index.js';
import { assistant } from './conversation.js';
import { connection } from './server.js';

export function toolConversation(effect: 'read' | 'write' = 'read'): StoredConversation & { runs: ToolRunRecord[] } {
  const config = { ...connection('http://127.0.0.1:1'),
    toolCalling: { supported: true as const, supportedThinkingLevels: ['off' as const, 'high' as const] } };
  const tool = toolSnapshot({ name: 'fixture', version: '1', label: '隔离工具', description: '读取或写入测试记录。',
    parameters: Type.Object({ amount: Type.Number() }, { additionalProperties: false }),
    effect, approval: effect === 'write' ? 'always' : 'never', resources: ['fixture:record'], timeoutMs: 1000 });
  const args = { amount: 3 };
  const identity = { sessionId: 's', runId: 'r', turnId: 'turn-1', toolCallId: 'call-1' };
  const call: ToolCallRecord = { ...identity, toolName: tool.name, toolVersion: tool.version, args,
    argsDigest: argumentsDigest(args), effect, approval: tool.approval, createdAt: 100,
    status: 'succeeded', startedAt: 110, finishedAt: 120,
    result: { content: [{ type: 'text', text: 'value 3' }], details: { value: 3 } } };
  const final = { ...assistant('final answer'), timestamp: 130 };
  const transcript: ToolRunRecord['transcript'] = [
    { sessionId: 's', runId: 'r', turnId: 'turn-1', messageId: 'm1', ordinal: 0, message: {
      ...assistant(''), timestamp: 100, stopReason: 'toolUse', content: [
        { type: 'thinking', thinking: 'native reasoning', thinkingSignature: 'reasoning_content' },
        { type: 'toolCall', id: call.toolCallId, name: tool.name, arguments: args, thoughtSignature: 'call-signature' },
      ],
    } },
    { sessionId: 's', runId: 'r', turnId: 'turn-1', messageId: 'm2', ordinal: 1, message: {
      role: 'toolResult', toolCallId: call.toolCallId, toolName: tool.name, content: [...call.result.content],
      details: { value: 3 }, isError: false, timestamp: 120,
    } },
    { sessionId: 's', runId: 'r', turnId: 'turn-2', messageId: 'm3', ordinal: 2, message: final },
  ];
  const run: ToolRunRecord = { runId: 'r', sessionId: 's', userMessageId: 'u', modelConfigSnapshot: config,
    status: 'completed', text: 'final answer', thinking: 'reasoning', notices: [], lastEventSequence: 0,
    createdAt: 100, finishedAt: 130, nativeMessage: final, toolsSnapshot: [tool], transcript, toolCalls: [call],
    approvals: effect === 'write' ? [{ ...identity, toolName: tool.name, toolVersion: tool.version,
      argsDigest: call.argsDigest, approvalId: 'approval-1', summary: '写入隔离记录', resources: ['fixture:record'],
      createdAt: 100, expiresAt: 1000, status: 'approved', decidedAt: 105 }] : [] };
  return { session: { sessionId: 's', title: 'tools', connectionId: 'fixture', createdAt: 100, updatedAt: 130, version: 1 },
    messages: [{ sessionId: 's', messageId: 'u', clientMessageId: 'client-1', role: 'user', content: 'use tool', timestamp: 100 }], runs: [run] };
}

export function pendingConversation(effect: 'read' | 'write' = 'read', awaiting = false) {
  const data = toolConversation(effect);
  const run = data.runs[0]!;
  const source = run.toolCalls[0]!;
  const { result: _result, finishedAt: _finished, status: _status, ...base } = source as Extract<ToolCallRecord, { status: 'succeeded' }>;
  run.status = 'running'; delete run.finishedAt; delete run.nativeMessage;
  run.text = ''; run.transcript = run.transcript.slice(0, 1);
  if (awaiting) {
    const { startedAt: _started, ...before } = base;
    run.toolCalls = [{ ...before, status: 'awaiting_approval', approvalId: 'approval-1' }];
    run.approvals = run.approvals.map(approval => {
      const { decidedAt: _decision, ...pending } = approval as typeof approval & { decidedAt: number };
      return { ...pending, status: 'pending' };
    });
  } else run.toolCalls = [{ ...base, status: 'running' }];
  return data;
}

export async function toolStoreFixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'dreamedge-tool-storage-'));
  const path = join(directory, 'sessions.sqlite');
  const stores: SqliteSessionStore[] = [];
  const open = () => { const store = new SqliteSessionStore(path); stores.push(store); return store; };
  const store = open();
  const faults = new DatabaseSync(path);
  t.after(async () => { faults.close(); for (const value of stores) value.close(); await rm(directory, { recursive: true, force: true }); });
  return { path, directory, store, faults, open };
}
