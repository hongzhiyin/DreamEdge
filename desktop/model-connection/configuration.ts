import { ModelFailure } from '../development/model';

export interface ConnectionConfiguration { apiKey?: string; model?: string; baseUrl?: string }
export function normalizeConfiguration(configuration: ConnectionConfiguration): Required<ConnectionConfiguration> {
  const { apiKey, model } = configuration;
  if (typeof apiKey !== 'string' || !apiKey.trim() || apiKey.length > 4096 || /[\x00-\x20\x7f]/.test(apiKey.trim())
    || typeof model !== 'string' || !model.trim() || model.length > 120 || /[\x00-\x1f\x7f]/.test(model)) throw new ModelFailure('请填写有效的 API Key 和模型名称。');
  let url: URL;
  try { url = new URL(configuration.baseUrl || 'https://api.openai.com/v1'); }
  catch { throw new ModelFailure('模型服务地址格式无效。'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.href.length > 2048) {
    throw new ModelFailure('模型服务地址必须是不包含凭据或查询参数的 HTTPS API 基础地址。');
  }
  if (model.trim().includes(apiKey.trim()) || decodeURIComponent(url.pathname).includes(apiKey.trim())) throw new ModelFailure('模型名称或服务地址不能包含 API Key。');
  if (url.hostname === 'api.openai.com' && model.trim().toLowerCase().startsWith('deepseek')) {
    throw new ModelFailure('DeepSeek 模型应使用 https://api.deepseek.com，请选择 DeepSeek 预设并填写对应的 Key。');
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  return { apiKey: apiKey.trim(), model: model.trim(), baseUrl: url.href.replace(/\/$/, '') };
}
