import type { ConnectionConfiguration } from '../model-connection/configuration';
import { ModelFailure } from './model';
import { guardedResponse } from './provider-stream';
import { httpFailure } from './responses-transport';

/** Framework boundary around pi's provider transport; it never parses provider events. */
export function providerFetch(configuration: Required<ConnectionConfiguration>, transport: typeof fetch, signal: AbortSignal): typeof fetch {
  return async (input, options) => {
    const request = new Request(input, options);
    if (request.url !== configuration.baseUrl + '/responses' || request.method !== 'POST'
      || request.headers.get('Authorization') !== `Bearer ${configuration.apiKey}`) throw new ModelFailure('模型请求不属于当前配置的服务。');
    const body = await request.clone().text();
    if (Buffer.byteLength(body) > 1024 * 1024) throw new ModelFailure('本轮工具上下文已达到上限，请缩小范围。');
    if (body.includes(configuration.apiKey)) throw new ModelFailure('请求上下文包含模型连接凭据，已停止发送。');
    const combined = AbortSignal.any([signal, request.signal]); combined.throwIfAborted();
    let response: Response;
    try { response = await transport(request.url, { ...options, method: request.method, headers: request.headers, body, signal: combined, redirect: 'error' }); }
    catch { throw new ModelFailure('无法连接模型服务，请检查网络和服务地址。'); }
    if (!response.ok) {
      await response.body?.cancel();
      return Response.json({ error: { message: httpFailure(response.status, new URL(configuration.baseUrl).hostname) } }, { status: response.status });
    }
    if (!response.body) throw new ModelFailure('模型响应为空。');
    return guardedResponse(response, configuration.apiKey, combined);
  };
}
