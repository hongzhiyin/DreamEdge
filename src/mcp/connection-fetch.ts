import type { McpFetch } from '@earendil-works/pi-mcp';
import type { McpTransportContext } from './connection-types.js';
import { McpConnectionError } from './connection-errors.js';
export const MCP_MESSAGE_BYTES = 1024 * 1024;
export function allowedMcpUrl(value: string | URL): URL {
  let url: URL; try { url = new URL(value); } catch { throw new McpConnectionError('TARGET_DENIED'); }
  if (url.username || url.password || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname)))) throw new McpConnectionError('TARGET_DENIED');
  return url;
}
/** Redirects must never carry credentials to another endpoint, even when fetch is injected. */
export function guardedMcpFetch(accept: (url: URL) => boolean, context: McpTransportContext, implementation: McpFetch = globalThis.fetch, allowCleanup = false): McpFetch {
  return async (input, init = {}) => {
    const cleanup = allowCleanup && init.method === 'DELETE';
    context.check(); if (!cleanup) context.signal.throwIfAborted(); const url = allowedMcpUrl(input);
    if (!accept(url)) throw new McpConnectionError('TARGET_DENIED');
    const signal = cleanup ? (init.signal ?? AbortSignal.timeout(1000)) : init.signal ? AbortSignal.any([context.signal, init.signal]) : context.signal;
    if (allowCleanup && init.method === 'POST' && typeof init.body === 'string') {
      const message = JSON.parse(init.body) as { method?: string; id?: string | number };
      if (message.method === 'tools/call' || message.method === 'resources/read') {
        if (!context.checkToolRequest || message.id === undefined) throw new McpConnectionError('TARGET_DENIED');
        context.checkToolRequest(message.id);
      }
    }
    const response = await implementation(url, { ...init, redirect: 'manual', signal });
    try {
      context.check(); signal.throwIfAborted();
      if (response.redirected || (response.status >= 300 && response.status < 400) || (response.url && response.url !== url.href)) throw new McpConnectionError('TARGET_DENIED');
    } catch (error) { await response.body?.cancel().catch(() => {}); throw error; }
    if (!response.body || response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() === 'text/event-stream') return response;
    const reader = response.body.getReader(); let size = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          context.check(); signal.throwIfAborted(); const part = await reader.read();
          if (part.done) { controller.close(); reader.releaseLock(); return; }
          size += part.value.byteLength;
          if (size > MCP_MESSAGE_BYTES) throw new McpConnectionError('LIMIT_EXCEEDED'); controller.enqueue(part.value);
        } catch (error) { await reader.cancel().catch(() => {}); controller.error(error); }
      }, cancel: reason => reader.cancel(reason),
    });
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}
