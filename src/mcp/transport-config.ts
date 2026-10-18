import type { McpCredentialRef, McpHttpAuth, McpTransportConfig } from './types.js';
import { absolutePath, credentialRef, id, invalid, object, string } from './validation.js';

function auth(value: unknown): McpHttpAuth {
  const source = object(value, ['type', 'credentialRef', 'profileId'], 'transport.auth');
  if (source.type === 'none' && Object.keys(source).length === 1) return { type: 'none' };
  if (source.type === 'bearer' && source.profileId === undefined) {
    return { type: 'bearer', credentialRef: credentialRef(source.credentialRef, 'transport.auth.credentialRef') };
  }
  if (source.type === 'oauth' && source.credentialRef === undefined) {
    return { type: 'oauth', profileId: id(source.profileId, 'transport.auth.profileId') };
  }
  return invalid('transport.auth');
}
function endpoint(value: unknown): string {
  const text = string(value, 'transport.url'); let url: URL;
  try { url = new URL(text); } catch { return invalid('transport.url'); }
  if (url.username || url.password || url.search || url.hash || /[\r\n\t]/.test(text)) invalid('transport.url');
  const localHttp = url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !localHttp) invalid('transport.url');
  return url.href;
}
export function parseMcpTransport(value: unknown): McpTransportConfig {
  const kind = object(value, ['type', 'command', 'args', 'cwd', 'envRefs', 'url', 'auth'], 'transport');
  if (kind.type === 'stdio') {
    const source = object(value, ['type', 'command', 'args', 'cwd', 'envRefs'], 'transport.stdio');
    const args = source.args ?? [];
    if (!Array.isArray(args) || args.length > 128 || args.some(a => typeof a !== 'string' || a.length > 8192 || a.includes('\0'))) invalid('transport.args');
    const refs = source.envRefs ?? {};
    if (!refs || typeof refs !== 'object' || Array.isArray(refs) || Object.keys(refs).length > 32) invalid('transport.envRefs');
    const envRefs: Record<string, McpCredentialRef> = {};
    for (const [key, value] of Object.entries(refs)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || ['__proto__', 'constructor', 'prototype'].includes(key)) invalid('transport.envRefs');
      envRefs[key] = credentialRef(value, 'transport.envRefs');
    }
    return { type: 'stdio', command: absolutePath(source.command, 'transport.command'), args: [...args], envRefs,
      ...(source.cwd === undefined ? {} : { cwd: absolutePath(source.cwd, 'transport.cwd') }) };
  }
  if (kind.type === 'streamable-http') {
    const source = object(value, ['type', 'url', 'auth'], 'transport.http');
    return { type: 'streamable-http', url: endpoint(source.url), auth: auth(source.auth ?? { type: 'none' }) };
  }
  return invalid('transport.type');
}
