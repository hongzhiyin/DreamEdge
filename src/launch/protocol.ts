import { parseMcpOffer, type LaunchMcpOffer } from './mcp-offer.js';
/** App-neutral handoff. MCP declarations require a separate explicit host grant. */
export const launchProtocol = 'ai-session-launch/v1';
export interface LaunchApp { id: string; name: string; profile: string }
export interface LaunchContext { window: string; resource: string; revision?: string }
export interface OpenSession {
  protocol: typeof launchProtocol; operation: 'open-session'; requestId: string;
  application: LaunchApp; context: LaunchContext; mcp?: LaunchMcpOffer;
}
export type LaunchRequest = OpenSession | { protocol: typeof launchProtocol; operation: 'status' }
  | { protocol: typeof launchProtocol; operation: 'revoke'; application: LaunchApp };
export class LaunchError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
function record(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !keys.includes(key))) throw new LaunchError('INVALID_REQUEST', '启动请求字段无效。');
  return value as Record<string, unknown>;
}
function text(value: unknown, max = 256): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f]/.test(value)) {
    throw new LaunchError('INVALID_REQUEST', '启动请求文本无效。');
  }
  return value;
}
export function parseLaunchRequest(value: unknown): LaunchRequest {
  const base = record(value, ['protocol', 'operation', 'requestId', 'application', 'context', 'mcp']);
  if (base.protocol !== launchProtocol) throw new LaunchError('UNSUPPORTED_PROTOCOL', '不支持此启动协议版本。');
  if (base.operation === 'status') { record(value, ['protocol', 'operation']); return { protocol: launchProtocol, operation: 'status' }; }
  const a = record(base.application, ['id', 'name', 'profile']);
  const application = { id: text(a.id), name: text(a.name, 100), profile: text(a.profile) };
  if (base.operation === 'revoke') {
    record(value, ['protocol', 'operation', 'application']); return { protocol: launchProtocol, operation: 'revoke', application };
  }
  if (base.operation !== 'open-session') throw new LaunchError('INVALID_REQUEST', '启动操作无效。');
  const c = record(base.context, ['window', 'resource', 'revision']);
  return { protocol: launchProtocol, operation: 'open-session', requestId: text(base.requestId), application,
    ...(base.mcp === undefined ? {} : { mcp: parseMcpOffer(base.mcp) }),
    context: { window: text(c.window), resource: text(c.resource), ...(c.revision === undefined ? {} : { revision: text(c.revision) }) } };
}
export function applicationKey(app: LaunchApp): string { return JSON.stringify([app.id, app.profile]); }
export function contextKey(request: OpenSession): string {
  const key = [request.application.id, request.application.profile, request.context.window, request.context.resource];
  return JSON.stringify(request.mcp ? [...key, 'mcp'] : key);
}
