import type { ModelConnection } from '../../shared/contracts';
import type { ModelAccess, ModelInput, ModelProvider } from './model';
import { ModelFailure, modelPrompt, proposalSchema } from './model';
import { normalizeConfiguration, requestResponse } from './responses-transport';
import { runProjectAgent } from './agent';

import type { ConnectionConfiguration as Configuration } from '../model-connection/configuration';
interface OutputMessage { type: string; content?: { type: string; text?: string }[] }
export { normalizeConfiguration } from './responses-transport';
export class ResponsesModel implements ModelProvider {
  private readonly configuration: Configuration;
  constructor(configuration: Configuration, private readonly transport: typeof fetch = fetch) {
    this.configuration = { ...configuration };
  }
  async connection(): Promise<ModelConnection> {
    try {
      normalizeConfiguration(this.configuration);
      return { provider: 'responses', available: true, detail: 'API 配置已就绪；服务可用性需通过实际请求确认。' };
    } catch {
      return { provider: 'responses', available: false, detail: '请配置有效的 API Key、模型名称和 HTTPS 服务地址。' };
    }
  }
  async probe(signal: AbortSignal): Promise<void> {
    const configuration = normalizeConfiguration(this.configuration);
    try {
      const result = await requestResponse(configuration, this.transport, { max_output_tokens: 1024,
        input: 'Connection test. Return an object with ok=true.', tools: [],
        text: { format: { type: 'json_schema', name: 'dreamedge_connection', strict: true,
          schema: { type: 'object', additionalProperties: false, required: ['ok'], properties: { ok: { type: 'boolean' } } } } } }, signal) as { status?: string; output?: OutputMessage[] };
      const text = result.output?.filter(item => item.type === 'message').flatMap(item => item.content ?? [])
        .filter(item => item.type === 'output_text').map(item => item.text ?? '').join('');
      if (result.status !== 'completed' || !text || JSON.parse(text).ok !== true) throw new Error();
    } catch (error) {
      if (error instanceof ModelFailure) throw error;
      throw new ModelFailure('服务未返回有效的结构化连接测试结果，请检查 Responses 支持情况。');
    }
  }
  async generate(input: ModelInput, signal: AbortSignal, access?: ModelAccess): Promise<unknown> {
    const configuration = normalizeConfiguration(this.configuration);
    if (access) return runProjectAgent(input, configuration, this.transport, signal, access);
    const result = await requestResponse(configuration, this.transport, { max_output_tokens: 16384, input: modelPrompt(input), tools: [],
      text: { format: { type: 'json_schema', name: 'dreamedge_changes', strict: true, schema: proposalSchema } } }, signal) as { status?: string; output?: OutputMessage[] };
    if (!result || result.status !== 'completed' || !Array.isArray(result.output)) throw new ModelFailure('模型请求未完整完成。');
    const messages = result.output.filter(item => item.type === 'message');
    const content = messages.flatMap(item => item.content || []);
    if (content.some(item => item.type === 'refusal')) throw new ModelFailure('模型拒绝了此次请求。');
    const text = content.filter(item => item.type === 'output_text').map(item => item.text || '').join('');
    if (!text) throw new ModelFailure('模型未返回候选变更。');
    try { return JSON.parse(text); }
    catch { throw new ModelFailure('模型返回的候选变更不是有效 JSON。'); }
  }
}
