import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { createCredentialResolver, parseModelConnection, PiRuntime } from '../src/index.js';
import type { RuntimeEvent, RuntimeHandle } from '../src/index.js';

async function probe(runtime: PiRuntime, cancelAfterText: boolean) {
  const began = performance.now();
  const sessionId = randomUUID();
  const runId = randomUUID();
  const events: RuntimeEvent[] = [];
  const textParts: string[] = [];
  const thinkingParts: string[] = [];
  let firstTextMs: number | undefined;
  let firstThinkingMs: number | undefined;
  let cancelledAt: number | undefined;
  let handle: RuntimeHandle;
  let identityValid = true;
  handle = runtime.start({
    sessionId, runId,
    messages: [{ role: 'user', timestamp: Date.now(), content: cancelAfterText
      ? '请连续列出 100 条整理书桌的小建议，每条单独一行，不要省略。'
      : '请用中文写 5 条整理书桌的小建议，每条单独一行，每条约 20 字。' }],
  }, event => {
    identityValid &&= event.sessionId === sessionId && event.runId === runId;
    events.push(event);
    if (event.type !== 'delta') return;
    if (event.channel === 'thinking') {
      firstThinkingMs ??= Math.round(performance.now() - began);
      thinkingParts.push(event.delta);
    } else {
      firstTextMs ??= Math.round(performance.now() - began);
      textParts.push(event.delta);
      if (cancelAfterText && event.delta && cancelledAt === undefined) {
        cancelledAt = performance.now();
        handle.cancel();
      }
    }
  });
  const result = await handle.done;
  const ended = performance.now();
  const countAtDone = events.length;
  await delay(300);
  const terminal = events.filter(event => event.type === 'settled');
  const started = events.find(event => event.type === 'started');
  const checks = {
    identityAndSequence: identityValid && events.every((event, index) => event.sequence === index + 1),
    highThinking: started?.type === 'started' && started.thinkingLevel === 'high'
      && result.thinkingLevel === 'high' && thinkingParts.join('').length > 0,
    textReceived: textParts.join('').length > 0,
    singleFinalSettlement: terminal.length === 1 && events.at(-1)?.type === 'settled'
      && terminal[0]?.result.status === result.status,
    noEventsAfterDone: events.length === countAtDone,
    expectedStatus: result.status === (cancelAfterText ? 'cancelled' : 'completed'),
    ...(cancelAfterText ? {
      cancelledAfterText: cancelledAt !== undefined,
      cancellationSettledPromptly: cancelledAt !== undefined && ended - cancelledAt < 10_000,
      partialTextPreserved: result.text.length > 0 && result.text.startsWith(textParts.join('')),
      providerAborted: result.stopReason === 'aborted',
    } : {
      multipleTextDeltas: textParts.length > 1,
      completeTextMatchesDeltas: result.text === textParts.join(''),
      normalProviderStop: result.stopReason === 'stop',
    }),
  };
  return {
    case: cancelAfterText ? 'cancel-after-first-text' : 'stream-to-completion',
    passed: Object.values(checks).every(Boolean), checks,
    status: result.status, stopReason: result.stopReason, thinkingLevel: result.thinkingLevel,
    providerModel: result.message?.model,
    durationMs: Math.round(ended - began), firstTextMs, firstThinkingMs,
    cancellationSettlementMs: cancelledAt === undefined ? undefined : Math.round(ended - cancelledAt),
    textDeltaCount: textParts.length, thinkingDeltaCount: thinkingParts.length,
    receivedTextCharacters: textParts.join('').length, retainedTextCharacters: result.text.length,
    thinkingCharacters: thinkingParts.join('').length,
    usageAvailable: result.status === 'completed' && result.message !== undefined,
    inputTokens: result.status === 'completed' ? result.message?.usage.input : undefined,
    outputTokens: result.status === 'completed' ? result.message?.usage.output : undefined,
    postSettlementObservationMs: 300, error: result.error,
  };
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: {
    config: { type: 'string', default: 'config/deepseek.example.json' },
    credentials: { type: 'string', default: 'config/credentials.local.json' },
    report: { type: 'string', default: 'docs/validation/deepseek-latest.json' },
  } });
  const config = parseModelConnection(JSON.parse(await readFile(values.config, 'utf8')));
  const runtime = new PiRuntime(config, createCredentialResolver({ credentialsFile: values.credentials }));
  const startedAt = new Date().toISOString();
  const cases = [];
  for (const cancelAfterText of [false, true]) {
    process.stderr.write(`开始检查：${cancelAfterText ? '正文开始后取消' : '完整流式回复'}\n`);
    const result = await probe(runtime, cancelAfterText);
    cases.push(result);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.passed) break;
  }
  const report = {
    startedAt, finishedAt: new Date().toISOString(),
    connection: { baseUrl: config.baseUrl, model: config.model, protocol: config.protocol,
      thinkingLevel: config.thinkingLevel, maxOutputTokens: config.maxOutputTokens },
    passed: cases.length === 2 && cases.every(result => result.passed), cases,
    scope: 'Live client streaming and cancellation; remote computation and billing are not measured.',
  };
  await mkdir(dirname(values.report), { recursive: true });
  await writeFile(values.report, `${JSON.stringify(report, null, 2)}\n`);
  process.stderr.write(`联调摘要：${values.report}\n`);
  if (!report.passed) process.exitCode = 1;
}

void main().catch(() => {
  process.stderr.write('联调脚本无法执行；请检查配置、凭据文件和报告路径。\n');
  process.exitCode = 1;
});
