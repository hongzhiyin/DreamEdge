import assert from 'node:assert/strict';
import test from 'node:test';
import { assertRunTranscript, PiRuntime, parseModelConnection, toolSnapshot, ToolContractError } from '../src/index.js';
import type { RunMessageRecord } from '../src/index.js';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { connection, request } from './helpers/server.js';

const owner = { sessionId: 'session', runId: 'run' };
function assistant(content: AssistantMessage['content'], stopReason: AssistantMessage['stopReason']): AssistantMessage {
  return { role: 'assistant', content, stopReason, api: 'openai-completions', provider: 'fixture', model: 'fixture',
    timestamp: 100, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}
const records: RunMessageRecord[] = [
  { ...owner, ordinal: 0, messageId: 'm1', turnId: 't1', message: assistant([
    { type: 'toolCall', id: 'c1', name: 'fixture', arguments: {} },
  ], 'toolUse') },
  { ...owner, ordinal: 1, messageId: 'm2', turnId: 't1', message: { role: 'toolResult', toolCallId: 'c1',
    toolName: 'fixture', content: [{ type: 'text', text: 'ok' }], isError: false, timestamp: 110 } },
  { ...owner, ordinal: 2, messageId: 'm3', turnId: 't2', message: assistant([{ type: 'text', text: 'done' }], 'stop') },
];

test('multi-turn transcript validates call/result pairing and permits pending checkpoints only explicitly', () => {
  assertRunTranscript(records, owner);
  assertRunTranscript(records.slice(0, 1), owner, false);
  assert.throws(() => assertRunTranscript(records.slice(0, 1), owner), ToolContractError);
  const cases = [
    records.map((record, i) => i === 1 ? { ...record, runId: 'other' } : record),
    records.map((record, i) => i === 1 ? { ...record, ordinal: 3 } : record),
    records.map((record, i) => i === 1 ? { ...record, turnId: 'other' } : record),
    records.map((record, i) => i === 1 ? { ...record, messageId: 'm1' } : record),
    records.map((record, i) => i === 1 ? { ...record, message: { ...record.message, toolName: 'other' } } : record),
    records.map((record, i) => i === 2 ? { ...record, turnId: 't1' } : record),
    [records[1]!], [records[0]!, { ...records[2]!, ordinal: 1 }],
    [...records, { ...records[1]!, ordinal: 3, messageId: 'duplicate-result' }],
    [...records.slice(0, 2), { ...records[0]!, ordinal: 2, messageId: 'duplicate-call', turnId: 't2' }],
  ];
  for (const input of cases) assert.throws(() => assertRunTranscript(input, owner), ToolContractError);
});

test('tool capability parsing preserves legacy configs and rejects contradictory declarations', () => {
  const base = connection('http://127.0.0.1:1');
  assert.equal(parseModelConnection(base).toolCalling, undefined);
  assert.deepEqual(parseModelConnection({ ...base, toolCalling: { supported: false } }).toolCalling, { supported: false });
  assert.deepEqual(parseModelConnection({ ...base, toolCalling: { supported: true, supportedThinkingLevels: ['off', 'high'] } }).toolCalling,
    { supported: true, supportedThinkingLevels: ['off', 'high'] });
  for (const toolCalling of [{ supported: 'yes' }, { supported: true }, { supported: true, supportedThinkingLevels: [] },
    { supported: false, supportedThinkingLevels: ['high'] }, { supported: true, supportedThinkingLevels: ['unknown'] },
    { supported: true, supportedThinkingLevels: ['high'], key: 'extra' }]) {
    assert.throws(() => parseModelConnection({ ...base, toolCalling }));
  }
  assert.throws(() => parseModelConnection({ ...base, reasoning: { supportedLevels: ['off'] },
    toolCalling: { supported: true, supportedThinkingLevels: ['high'] } }));
});

test('text runtime explicitly rejects tool snapshots before credentials or dispatch', async () => {
  let credentialsRead = 0;
  const runtime = new PiRuntime(connection('http://127.0.0.1:1'), async () => { credentialsRead++; return 'fixture'; });
  const tools = [toolSnapshot({ name: 'fixture', version: '1', label: 'fixture', description: 'fixture',
    parameters: { type: 'object', properties: {}, additionalProperties: false }, effect: 'read', approval: 'never', resources: [], timeoutMs: 1000 })];
  const result = await runtime.start({ ...request(), tools }).done;
  assert.equal(result.status, 'failed'); assert.equal(result.error?.code, 'TOOLS_NOT_ENABLED');
  assert.equal(credentialsRead, 0);
});
