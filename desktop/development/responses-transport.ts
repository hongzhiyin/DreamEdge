import type { ConnectionConfiguration } from '../model-connection/configuration';
import { ModelFailure } from './model';

export { normalizeConfiguration } from '../model-connection/configuration';
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
    throw new ModelFailure(httpFailure(response.status, new URL(configuration.baseUrl).hostname));
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

function httpFailure(status: number, host: string): string {
  if (status === 401) return `认证失败（HTTP 401）。请确认 API Key 属于 ${host}，并检查 Key 是否完整或已失效。`;
  if (status === 402) return '账号余额不足（HTTP 402），请检查对应模型服务的余额。';
  if (status === 403) return '模型访问被拒绝（HTTP 403），请检查账号和模型权限。';
  if (status === 404) return '请求地址或模型不存在（HTTP 404），请检查 API 基础地址和模型名称。';
  if (status === 429) return '请求受限（HTTP 429），请检查余额、服务限额或稍后重试。';
  return `模型服务请求失败（HTTP ${status}），请检查服务状态后重试。`;
}
