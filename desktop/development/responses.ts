import type { ModelConnection } from '../../shared/contracts';
import type { ModelInput, ModelProvider } from './model';
import { ModelFailure, modelPrompt, proposalSchema } from './model';

interface Configuration { apiKey?: string; model?: string; baseUrl?: string }
interface OutputMessage { type: string; content?: { type: string; text?: string }[] }
const RESPONSE_LIMIT = 1024 * 1024;
function settings(configuration: Configuration): { key: string; model: string; endpoint: string } {
  const { apiKey, model } = configuration;
  if (!apiKey?.trim() || /[\r\n]/.test(apiKey) || !model?.trim() || model.length > 120 || /[\x00-\x1f]/.test(model)) {
    throw new ModelFailure('请在主进程配置 API Key 和模型名称。');
  }
  let url: URL;
  try { url = new URL(configuration.baseUrl || 'https://api.openai.com/v1'); }
  catch { throw new ModelFailure('模型服务地址格式无效。'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new ModelFailure('模型服务地址必须是不包含凭据或查询参数的 HTTPS API 基础地址。');
  }
  url.pathname = url.pathname.replace(/\/$/, '') + '/responses';
  return { key: apiKey.trim(), model: model.trim(), endpoint: url.href };
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
      settings(this.configuration);
      return { provider: 'responses', available: true, detail: 'API 配置已就绪；服务可用性需通过实际请求确认。' };
    } catch {
      return { provider: 'responses', available: false, detail: '请配置有效的 API Key、模型名称和 HTTPS 服务地址。' };
    }
  }
  async generate(input: ModelInput, signal: AbortSignal): Promise<unknown> {
    const configuration = settings(this.configuration);
    let response: Response;
    try { response = await this.transport(configuration.endpoint, {
      method: 'POST', signal, redirect: 'error',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${configuration.key}` },
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
