import { createModels, createProvider } from '@earendil-works/pi-ai';
import type { Model, ThinkingLevelMap } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy';
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy';
import { googleGenerativeAIApi } from '@earendil-works/pi-ai/api/google-generative-ai.lazy';
import { parseModelConnection } from './config.js';
import { abortable, ModelAdapterError } from './errors.js';
import { thinkingLevels } from './types.js';
import type { CredentialResolver, ModelConnectionConfig, ModelProtocol, ThinkingLevel } from './types.js';

const adapters = {
  'openai-completions': openAICompletionsApi,
  'openai-responses': openAIResponsesApi,
  'anthropic-messages': anthropicMessagesApi,
  'google-generative-ai': googleGenerativeAIApi,
};

export async function connectModel(
  input: ModelConnectionConfig, credentials: CredentialResolver,
  signal: AbortSignal, requested?: ThinkingLevel,
) {
  const config = parseModelConnection(input);
  const supported = config.reasoning?.supportedLevels ?? ['off'];
  const explicit = requested ?? config.thinkingLevel;
  const thinkingLevel: ThinkingLevel = explicit ?? (config.reasoning ? 'high' : 'off');
  if (!supported.includes(thinkingLevel)) {
    throw new ModelAdapterError('UNSUPPORTED_THINKING', '该模型连接不支持指定的思考强度。');
  }
  let secret: string | undefined;
  signal.throwIfAborted();
  try { secret = await abortable(credentials(config.credentialRef, signal), signal); }
  catch (error) {
    if (signal.aborted) throw signal.reason;
    throw new ModelAdapterError('CREDENTIAL_ACCESS_FAILED', '无法读取模型凭据。');
  }
  signal.throwIfAborted();
  if (!secret?.trim()) throw new ModelAdapterError('MISSING_CREDENTIAL', '模型凭据未配置。');
  const apiKey = secret;
  const thinkingLevelMap: ThinkingLevelMap = {};
  for (const level of thinkingLevels) {
    if (!supported.includes(level)) thinkingLevelMap[level] = null;
  }
  Object.assign(thinkingLevelMap, config.reasoning?.effortMap);
  const model: Model<ModelProtocol> = {
    id: config.model, name: config.model, api: config.protocol, provider: config.id,
    baseUrl: config.baseUrl, input: ['text'],
    reasoning: supported.some(level => level !== 'off'), thinkingLevelMap,
    contextWindow: config.contextWindow, maxTokens: config.maxOutputTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ...(config.protocol === 'openai-completions' ? {
      compat: {
        supportsReasoningEffort: true, supportsFinishReason: true,
        thinkingFormat: config.reasoning?.format ?? 'openai',
        ...(config.reasoning?.format === 'deepseek' ? {
          supportsStore: false, supportsDeveloperRole: false,
          maxTokensField: 'max_tokens' as const, requiresReasoningContentOnAssistantMessages: true,
        } : {}),
      },
    } : {}),
  };
  const models = createModels();
  models.setProvider(createProvider({
    id: config.id, models: [model], api: adapters[config.protocol](),
    auth: { apiKey: { name: config.id, resolve: async () => ({ auth: { apiKey } }) } },
  }));
  const notices = !config.reasoning && !explicit ? ['该连接未声明思考能力，使用非思考模式。'] : [];
  return { config, model, models, secret, thinkingLevel, notices };
}
