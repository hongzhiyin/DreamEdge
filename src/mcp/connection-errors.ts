import { McpAbortError, McpAuthRequiredError, McpTimeoutError, McpSessionExpiredError, McpConnectionClosedError } from '@earendil-works/pi-mcp';
import { McpOAuthAuthorizationRequiredError } from '@earendil-works/pi-mcp/oauth';
import type { McpConnectionErrorCode } from './connection-types.js';
const messages: Record<McpConnectionErrorCode, string> = {
  APPROVAL_REQUIRED: '此 MCP 配置尚未获准连接。', CONFIG_CHANGED: 'MCP 配置或连接批准已失效。', UNAVAILABLE: 'MCP 服务连接或协议处理失败。',
  AUTH_REQUIRED: 'MCP 服务需要有效凭据或登录。', TIMEOUT: 'MCP 连接或目录读取超时。', INVALID_CATALOG: 'MCP 能力目录无效。',
  LIMIT_EXCEEDED: 'MCP 能力目录超过宿主限制。', TARGET_DENIED: 'MCP 请求目标或重定向不在已批准范围内。',
  CANCELLED: 'MCP 连接准备已取消。', CLOSED: 'MCP 连接已关闭。',
};
export class McpConnectionError extends Error {
  constructor(readonly code: McpConnectionErrorCode) { super(messages[code]); this.name = 'McpConnectionError'; }
}
export function connectionFailure(error: unknown): McpConnectionError {
  if (error instanceof McpConnectionError) return error;
  if (error instanceof McpAuthRequiredError || error instanceof McpOAuthAuthorizationRequiredError) return new McpConnectionError('AUTH_REQUIRED');
  if (error instanceof McpTimeoutError) return new McpConnectionError('TIMEOUT');
  if (error instanceof McpSessionExpiredError || error instanceof McpConnectionClosedError) return new McpConnectionError('CLOSED');
  if (error instanceof McpAbortError) return new McpConnectionError('CANCELLED');
  return new McpConnectionError('UNAVAILABLE');
}
/** Observe late settlement without exposing an uncancellable host callback as live work. */
export function connectionWait<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason instanceof McpConnectionError ? signal.reason : new McpConnectionError('CANCELLED'));
    signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
