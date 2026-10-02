import type { ConnectionConfiguration } from '../model-connection/vault';
import { ModelFailure } from './model';

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
  url.pathname = url.pathname.replace(/\/+$/, '');
  return { apiKey: apiKey.trim(), model: model.trim(), baseUrl: url.href.replace(/\/$/, '') };
}
export async function requestResponse(configuration: Required<ConnectionConfiguration>, transport: typeof fetch, payload: object, signal: AbortSignal): Promise<unknown> {
  const body = JSON.stringify({ model: configuration.model, store: false, stream: false, ...payload });
  if (body.includes(configuration.apiKey)) throw new ModelFailure('请求上下文包含模型连接凭据，已停止发送。');
  let response: Response;
  try {
    signal.throwIfAborted();
    response = await transport(configuration.baseUrl + '/responses', { method: 'POST', signal, redirect: 'error',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${configuration.apiKey}` }, body });
  } catch { throw new ModelFailure('无法连接模型服务，请检查网络和服务地址。'); }
  if (!response.ok) {
    await response.body?.cancel();
    throw new ModelFailure(`模型服务请求失败（HTTP ${response.status}），请检查凭据、模型权限或服务限额。`);
  }
  if (!response.body) throw new ModelFailure('模型响应为空。');
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    while (true) {
      signal.throwIfAborted(); const next = await reader.read(); if (next.done) break;
      bytes += next.value.byteLength; if (bytes > 1024 * 1024) throw new Error(); chunks.push(next.value);
    }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
    if (text.includes(configuration.apiKey)) throw new ModelFailure('模型回复包含连接凭据，已拒绝使用。');
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof ModelFailure) throw error;
    throw new ModelFailure('模型响应无法解析或超过大小限制。');
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
