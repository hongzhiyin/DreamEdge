import { StdioTransport, StreamableHttpTransport } from '@earendil-works/pi-mcp';
import type { AuthProvider } from '@earendil-works/pi-mcp';
import { adaptOAuthProvider } from '@earendil-works/pi-mcp/oauth';
import type { McpConnectionOptions, McpHostTransportFactory } from './connection-types.js';
import { connectionWait, McpConnectionError } from './connection-errors.js';
import { allowedMcpUrl, guardedMcpFetch, MCP_MESSAGE_BYTES } from './connection-fetch.js';

export function createMcpTransportFactory(options: McpConnectionOptions): McpHostTransportFactory {
  const systemEnv: Record<string, string> = {};
  for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR']) if (process.env[key]) systemEnv[key] = process.env[key]!;
  return async (config, context) => {
    context.check(); context.signal.throwIfAborted();
    const credential = async (reference: string) => {
      let value: string | undefined;
      try { value = await connectionWait(Promise.resolve(options.credentials?.(reference, context.signal)), context.signal); }
      catch (error) { context.signal.throwIfAborted(); throw new McpConnectionError('AUTH_REQUIRED'); }
      context.check(); context.signal.throwIfAborted();
      if (!value || value.includes('\0')) throw new McpConnectionError('AUTH_REQUIRED'); return value;
    };
    if (config.transport.type === 'stdio') {
      const env = { ...systemEnv };
      for (const [name, ref] of Object.entries(config.transport.envRefs)) env[name] = await credential(ref);
      context.check(); return new StdioTransport({ command: config.transport.command, args: config.transport.args,
        ...(config.transport.cwd ? { cwd: config.transport.cwd } : {}), env, inheritEnv: false, stderr: 'pipe',
        maxMessageBytes: MCP_MESSAGE_BYTES, maxStderrBytes: 32768, closeTimeoutMs: 1000 });
    }
    const { url, auth } = config.transport; const endpoint = new URL(url).href;
    const serviceFetch = guardedMcpFetch(target => target.href === endpoint, context, options.fetch, true);
    let authProvider: AuthProvider | undefined;
    if (auth.type === 'bearer') authProvider = { async token() {
      const token = await credential(auth.credentialRef); if (/[\r\n]/.test(token)) throw new McpConnectionError('AUTH_REQUIRED'); return token;
    } };
    if (auth.type === 'oauth') {
      const profile = await connectionWait(Promise.resolve(options.oauthProfile?.(auth.profileId, url, context.signal)), context.signal);
      context.check(); if (!profile) throw new McpConnectionError('AUTH_REQUIRED');
      const origins = new Set([new URL(url).origin, ...profile.allowedOrigins.map(origin => allowedMcpUrl(origin).origin)]);
      const oauthFetch = guardedMcpFetch(target => origins.has(target.origin), context, options.fetch);
      const provider = adaptOAuthProvider(profile.provider);
      authProvider = {
        token: async () => { context.check(); const token = await connectionWait(provider.token(), context.signal); context.check(); return token; },
        onUnauthorized: async value => { context.check(); await connectionWait(Promise.resolve(provider.onUnauthorized?.({ ...value, fetch: oauthFetch })), context.signal); context.check(); },
      };
    }
    return new StreamableHttpTransport({ url, fetch: serviceFetch, ...(authProvider ? { authProvider } : {}),
      maxMessageBytes: MCP_MESSAGE_BYTES, reconnect: { initialDelayMs: 200, maxDelayMs: 5000, maxRetries: 3 } });
  };
}
