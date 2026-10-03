import type { Model } from '@earendil-works/pi-ai';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import type { ConnectionConfiguration } from '../model-connection/configuration';
import { ModelFailure } from './model';
import { providerFetch } from './provider-fetch';

export async function piProvider(configuration: Required<ConnectionConfiguration>, transport: typeof fetch, signal: AbortSignal): Promise<{ model: Model<'openai-responses'>; stream: StreamFn }> {
  const { streamSimple } = await import('@earendil-works/pi-ai/api/openai-responses');
  const model: Model<'openai-responses'> = { id: configuration.model, name: configuration.model, provider: 'dreamedge', api: 'openai-responses',
    baseUrl: configuration.baseUrl, input: ['text'], reasoning: false, contextWindow: 128000, maxTokens: 16384,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, compat: { supportsDeveloperRole: false, supportsStrictMode: true } };
  const fetch = providerFetch(configuration, transport, signal); let requests = 0;
  return { model, stream: (activeModel, context, options) => streamSimple(activeModel as Model<'openai-responses'>, context, {
    ...options, apiKey: configuration.apiKey, fetch, maxTokens: 16384, maxRetries: 0, cacheRetention: 'none', env: {},
    onPayload: payload => {
      signal.throwIfAborted();
      if (++requests > 12) throw new ModelFailure('本轮达到 12 次模型请求上限，请缩小任务范围后继续。');
      const body = JSON.stringify(payload);
      if (body.includes(configuration.apiKey)) throw new ModelFailure('请求上下文包含模型连接凭据，已停止发送。');
      if (Buffer.byteLength(body) > 1024 * 1024) throw new ModelFailure('本轮工具上下文已达到上限，请缩小范围。');
      return payload;
    },
  }) };
}
