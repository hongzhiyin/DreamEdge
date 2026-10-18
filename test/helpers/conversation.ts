import type { AssistantMessage } from '@earendil-works/pi-ai';
import { ConversationService } from '../../src/index.js';
import type { AgentRuntime, RuntimeEvent, RuntimeObserver, RuntimeRequest, RuntimeResult } from '../../src/index.js';
import { connection } from './server.js';

export function assistant(text: string, stopReason: AssistantMessage['stopReason'] = 'stop'): AssistantMessage {
  return { role: 'assistant', api: 'openai-completions', provider: 'fixture', model: 'fixture-model',
    content: [{ type: 'thinking', thinking: 'reasoning', thinkingSignature: 'native-signature' },
      { type: 'text', text, textSignature: 'native-text' }], stopReason, timestamp: 2,
    usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}

export class ControlledRun {
  readonly signal = new AbortController().signal;
  readonly done: Promise<RuntimeResult>;
  private resolve!: (result: RuntimeResult) => void;
  cancelCount = 0;

  constructor(readonly request: RuntimeRequest, private readonly observer?: RuntimeObserver) {
    this.done = new Promise(resolve => { this.resolve = resolve; });
  }

  async emit(sequence: number, delta: string, identity: Partial<RuntimeRequest> = {}): Promise<void> {
    const event: RuntimeEvent = { sessionId: identity.sessionId ?? this.request.sessionId,
      runId: identity.runId ?? this.request.runId, sequence, type: 'delta', channel: 'text', delta };
    await this.observer?.(event, this.signal);
  }

  async settled(sequence: number): Promise<void> {
    await this.observer?.({ sessionId: this.request.sessionId, runId: this.request.runId,
      sequence, type: 'settled', result: this.result('cancelled', 'partial') }, this.signal);
  }

  finish(status: RuntimeResult['status'] = 'completed', text = 'answer'): RuntimeResult {
    const result = this.result(status, text);
    this.resolve(result);
    return result;
  }

  private result(status: RuntimeResult['status'], text: string): RuntimeResult {
    const message = assistant(text, status === 'completed' ? 'stop' : status === 'cancelled' ? 'aborted' : 'error');
    return { sessionId: this.request.sessionId, runId: this.request.runId, status, text,
      stopReason: message.stopReason, message,
      ...(status === 'failed' ? { error: { code: 'REQUEST_FAILED', message: 'fixture failure' } as const } : {}) };
  }
}

export function conversationFixture() {
  const calls: ControlledRun[] = [];
  const config = connection('http://127.0.0.1:1');
  const runtime: AgentRuntime = { start(request, observer) {
    const run = new ControlledRun(request, observer);
    calls.push(run);
    return { cancel: () => { run.cancelCount++; }, done: run.done };
  } };
  const service = new ConversationService({ connection: () => config, runtime: () => runtime });
  const create = () => service.createSession({ connectionId: 'fixture' }).sessionId;
  return { service, calls, config, create };
}

export async function startPending(): Promise<void> { await Promise.resolve(); }
