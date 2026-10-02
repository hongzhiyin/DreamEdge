import type { ModelConnection } from '../../shared/contracts';
import type { ModelInput, ModelProvider } from './model';
import { ModelFailure, modelPrompt, proposalSchema } from './model';

import type { ConnectionConfiguration as Configuration } from '../model-connection/vault';
interface OutputMessage { type: string; content?: { type: string; text?: string }[] }
const RESPONSE_LIMIT = 1024 * 1024;
export function normalizeConfiguration(configuration: Configuration): Required<Configuration> {
  const { apiKey, model } = configuration;
  if (typeof apiKey !== 'string' || !apiKey.trim() || apiKey.length > 4096 || /[\x00-\x20\x7f]/.test(apiKey.trim())
    || typeof model !== 'string' || !model.trim() || model.length > 120 || /[\x00-\x1f\x7f]/.test(model)) {
    throw new ModelFailure('请填写有效的 API Key 和模型名称。');
  }
  let url: URL;
  try { url = new URL(configuration.baseUrl || 'https://api.openai.com/v1'); }
  catch { throw new ModelFailure('模型服务地址格式无效。'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.href.length > 2048) {
    throw new ModelFailure('模型服务地址必须是不包含凭据或查询参数的 HTTPS API 基础地址。');
  }
  if (model.trim().includes(apiKey.trim()) || decodeURIComponent(url.pathname).includes(apiKey.trim())) throw new ModelFailure('模型名称或服务地址不能包含 API Key。');
  url.pathname = url.pathname.replace(/\/+$/, '');
  return { apiKey: apiKey.trim(), model: model.trim(), baseUrl: url.href.replace(/\/$/, '') };
}
async function readResponse(response: Response): Promise<unknown> {
  if (!response.body) throw new Error('模型响应为空。');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > RESPONSE_LIMIT) throw new Error('模型响应超过 1 MB。');
      chunks.push(next.value);
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
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
    let response: Response;
    try {
      response = await this.transport(configuration.baseUrl + '/responses', { method: 'POST', signal, redirect: 'error',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${configuration.apiKey}` },
        body: JSON.stringify({ model: configuration.model, store: false, stream: false, max_output_tokens: 1024,
          input: 'Connection test. Return an object with ok=true.', tools: [],
          text: { format: { type: 'json_schema', name: 'dreamedge_connection', strict: true,
            schema: { type: 'object', additionalProperties: false, required: ['ok'], properties: { ok: { type: 'boolean' } } } } } }) });
    } catch { throw new ModelFailure('无法连接模型服务，或连接测试已超时。'); }
    if (!response.ok) { await response.body?.cancel(); throw new ModelFailure(`连接测试失败（HTTP ${response.status}），请核对凭据和模型权限。`); }
    try {
      const result = await readResponse(response) as { status?: string; output?: OutputMessage[] };
      const text = result.output?.filter(item => item.type === 'message').flatMap(item => item.content ?? [])
        .filter(item => item.type === 'output_text').map(item => item.text ?? '').join('');
      if (result.status !== 'completed' || !text || JSON.parse(text).ok !== true) throw new Error();
    } catch { throw new ModelFailure('服务未返回有效的结构化连接测试结果，请检查 Responses 支持情况。'); }
  }
  async generate(input: ModelInput, signal: AbortSignal): Promise<unknown> {
    const configuration = normalizeConfiguration(this.configuration);
    let response: Response;
    try { response = await this.transport(configuration.baseUrl + '/responses', {
      method: 'POST', signal, redirect: 'error',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${configuration.apiKey}` },
      body: JSON.stringify({ model: configuration.model, store: false, stream: false, max_output_tokens: 16384,
        input: modelPrompt(input), tools: [],
        text: { format: { type: 'json_schema', name: 'dreamedge_changes', strict: true, schema: proposalSchema } } }),
    }); } catch { throw new ModelFailure('无法连接模型服务，请检查网络和服务地址。'); }
    if (!response.ok) {
      await response.body?.cancel();
      throw new ModelFailure(`模型服务请求失败（HTTP ${response.status}），请检查凭据、模型权限或服务限额。`);
    }
    let result: { status?: string; output?: OutputMessage[] };
    try { result = await readResponse(response) as typeof result; }
    catch { throw new ModelFailure('模型响应无法解析或超过大小限制。'); }
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
export function configuredModel(environment: NodeJS.ProcessEnv): ResponsesModel {
  return new ResponsesModel({ apiKey: environment.DREAMEDGE_AI_API_KEY,
    model: environment.DREAMEDGE_AI_MODEL, baseUrl: environment.DREAMEDGE_AI_BASE_URL });
}
