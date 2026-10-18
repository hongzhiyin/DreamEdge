import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { builtInTools, ConversationService, createCredentialResolver, parseModelConnection, PiRuntime, SqliteSessionStore } from '../src/index.js';
import type { ConversationHandle, RunRecord, RuntimeEvent } from '../src/index.js';
import { observeWire } from './live-wire.js';

async function main() {
  const { values } = parseArgs({ options: {
    config: { type: 'string', default: 'config/deepseek.example.json' },
    credentials: { type: 'string', default: 'config/credentials.local.json' },
    report: { type: 'string', default: 'docs/validation/tool-deepseek-2026-10-14.json' },
  } });
  const config = parseModelConnection(JSON.parse(await readFile(values.config, 'utf8')));
  if (config.thinkingLevel !== 'high' || !config.toolCalling?.supported) throw new Error('Unsupported live config');
  const credentials = createCredentialResolver({ credentialsFile: values.credentials });
  if (!await credentials(config.credentialRef, new AbortController().signal)) throw new Error('Missing credentials');
  const directory = await mkdtemp(join(tmpdir(), 'dreamedge-live-tools-'));
  const store = new SqliteSessionStore(join(directory, 'sessions.sqlite'));
  const wire = observeWire(config.baseUrl); const registry = builtInTools();
  const startedAt = new Date().toISOString();
  const events: RuntimeEvent[] = [];
  let enableTools = true; let cancelAfterResultText = false; let handle: ConversationHandle | undefined;
  let cancelledAt: number | undefined;
  const service = new ConversationService({ store, connection: () => config,
    tools: () => enableTools ? registry.snapshots() : [],
    runtime: connection => {
      const runtime = new PiRuntime(connection, credentials, { registry });
      return { start: (request, observer) => runtime.start(request, async (event, signal) => {
        events.push(event); await observer?.(event, signal);
        if (cancelAfterResultText && event.type === 'delta' && event.channel === 'text' && event.delta
          && service.getSnapshot(request.sessionId).runs.at(-1)?.toolCalls?.some(call => call.status === 'succeeded')) {
          cancelledAt ??= performance.now(); handle?.cancel();
        }
      }) };
    } });
  const cases: { name: string; passed: boolean; checks: Record<string, boolean>; status: string; durationMs: number;
    modelTurns: number; tools: string[]; error?: string; cancellationMs?: number }[] = [];
  async function run(name: string, operation: () => ConversationHandle, check: (record: RunRecord) => Record<string, boolean>) {
    process.stderr.write(`开始真实工具检查：${name}\n`); const began = performance.now(); const eventIndex = events.length;
    handle = operation(); const record = await handle.done; const durationMs = Math.round(performance.now() - began);
    const runEvents = events.slice(eventIndex); const count = wire.requests.length; const eventCount = events.length;
    await delay(300);
    const checks = { ...check(record), highThinking: record.thinkingLevel === 'high',
      sequence: runEvents.every((event, index) => event.runId === record.runId && event.sequence === index + 1),
      singleSettlement: runEvents.filter(event => event.type === 'settled').length === 1,
      noRequestsAfterDone: wire.requests.length === count,
      noEventsAfterDone: events.length === eventCount,
      saved: service.getSnapshot(record.sessionId).saveState.status === 'saved',
      durableIdentity: store.load().find(item => item.session.sessionId === record.sessionId)?.runs.at(-1)?.runId === record.runId };
    const result = { name, passed: Object.values(checks).every(Boolean), checks, status: record.status, durationMs,
      modelTurns: runEvents.filter(event => event.type === 'message_started').length,
      tools: record.toolCalls?.map(call => call.toolName) ?? [], ...(record.error ? { error: record.error.code } : {}),
      ...(cancelledAt ? { cancellationMs: Math.round(performance.now() - cancelledAt - 300) } : {}) };
    cases.push(result); process.stdout.write(`${JSON.stringify(result)}\n`); return record;
  }
  try {
    const sessionId = service.createSession({ connectionId: config.id }).sessionId;
    const first = await run('tool-chain-and-continuation', () => service.send({ sessionId, clientMessageId: 'chain',
      text: '必须先调用 get_current_time 获取当前时间；等返回后再调用 add_numbers 计算 17+25。最后用一行返回时间和计算结果，不要自行计算或假装调用。' }), record => ({
      completed: record.status === 'completed', answer42: record.text.includes('42'),
      timeExecuted: record.toolCalls?.some(call => call.toolName === 'get_current_time' && call.status === 'succeeded') ?? false,
      additionExecuted: record.toolCalls?.some(call => call.toolName === 'add_numbers' && call.status === 'succeeded' && call.result.details !== undefined) ?? false,
      nativeToolReasoning: record.transcript?.filter(entry => entry.message.role === 'assistant'
        && entry.message.content.some(block => block.type === 'toolCall')).every(entry =>
        entry.message.role === 'assistant' && entry.message.content.some(block => block.type === 'thinking' && block.thinking.length > 0)) ?? false,
      wireTools: wire.requests[0]?.tools.includes('add_numbers') ?? false,
      nativeReasoningReplayed: wire.requests.some(request => request.messages.some(message => message.calls.length > 0 && message.reasoningCharacters > 0)) }));
    if (!cases.at(-1)!.passed) throw new Error('Live chain failed');
    await run('follow-up-reuses-tool-context', () => service.send({ sessionId, clientMessageId: 'follow-up',
      text: '上一轮加法工具返回的结果是多少？不要调用任何工具，只返回阿拉伯数字。' }), record => ({
      completed: record.status === 'completed', answer42: record.text.trim() === '42', noNewTools: record.toolCalls?.length === 0,
      previousResultsPresent: wire.requests.at(-1)?.messages.filter(message => message.role === 'tool').length === first.toolCalls?.length }));
    if (!cases.at(-1)!.passed) throw new Error('Live follow-up failed');
    const retrySession = service.createSession({ connectionId: config.id }).sessionId;
    wire.injectFailure();
    const failed = await run('controlled-failure-after-tool-result', () => service.send({ sessionId: retrySession,
      clientMessageId: 'retry', text: '调用 add_numbers 计算 19+23，返回工具结果。' }), record => ({
      expectedFailure: record.status === 'failed', resultRetained: record.toolCalls?.some(call => call.status === 'succeeded') ?? false,
      localFailureInjected: wire.requests.at(-1)?.injectedFailure ?? false }));
    if (!cases.at(-1)!.passed) throw new Error('Failure injection failed');
    await run('model-only-retry-reuses-result', () => service.retry(retrySession, failed.runId), record => ({
      completed: record.status === 'completed', answer42: record.text.includes('42'),
      noNewTools: !record.toolCalls?.length, noToolsOnWire: wire.requests.at(-1)?.tools.length === 0,
      reusedResult: wire.requests.at(-1)?.messages.some(message => message.role === 'tool') ?? false }));
    if (!cases.at(-1)!.passed) throw new Error('Live retry failed');
    const cancelSession = service.createSession({ connectionId: config.id }).sessionId;
    cancelAfterResultText = true;
    await run('cancel-stream-after-tool-result', () => service.send({ sessionId: cancelSession, clientMessageId: 'cancel',
      text: '先调用 add_numbers 计算 21+21。工具返回之后，连续列出100条简短的书桌整理建议，不要省略。' }), record => ({
      cancelled: record.status === 'cancelled', toolCompleted: record.toolCalls?.some(call => call.status === 'succeeded') ?? false,
      partialText: record.text.length > 0, providerAborted: record.stopReason === 'aborted',
      promptSettlement: cancelledAt !== undefined && performance.now() - cancelledAt < 10_000 }));
    if (!cases.at(-1)!.passed) throw new Error('Live cancellation failed');
    cancelAfterResultText = false; cancelledAt = undefined; enableTools = false;
    const textSession = service.createSession({ connectionId: config.id }).sessionId;
    await run('plain-text-regression', () => service.send({ sessionId: textSession, clientMessageId: 'text',
      text: '请用一句中文说明保持桌面整洁的好处。' }), record => ({
      completed: record.status === 'completed', textReceived: record.text.length > 0,
      noTools: !record.toolCalls?.length && wire.requests.at(-1)?.tools.length === 0 }));
  } finally {
    const report = { startedAt, finishedAt: new Date().toISOString(),
      connection: { baseUrl: config.baseUrl, model: config.model, thinkingLevel: config.thinkingLevel, maxOutputTokens: config.maxOutputTokens },
      passed: cases.length === 6 && cases.every(item => item.passed), cases, requests: wire.requests,
      realRequests: wire.requests.filter(request => !request.injectedFailure).length,
      injectedResponses: wire.requests.filter(request => request.injectedFailure).length,
      scope: 'Real DeepSeek with isolated SQLite. The 503 is locally injected before transport; no keys, prompts or response bodies saved.' };
    await mkdir(dirname(values.report), { recursive: true }); await writeFile(values.report, `${JSON.stringify(report, null, 2)}\n`);
    wire.restore(); await service.dispose(); await rm(directory, { recursive: true, force: true });
    if (!report.passed) process.exitCode = 1;
  }
}
void main().catch(() => { process.stderr.write('真实工具联调未通过，请查看无密钥验证摘要。\n'); process.exitCode = 1; });
