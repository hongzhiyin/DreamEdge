import type { McpServerConfig as PiServerConfig } from '@earendil-works/pi-coding-agent';
import { freezeDeep, jsonCopy } from '../tools/json.js';
import { parseMcpServerConfig } from './config.js';
import { McpConfigError, object } from './validation.js';
import type { McpServerConfig, McpCredentialRef } from './types.js';
export interface McpImportDiagnostic { index: number; field: string; code: 'UNSUPPORTED_FIELD' | 'REFERENCE_REQUIRED' | 'INVALID_ENTRY' }
export interface McpImportPreview { configs: McpServerConfig[]; diagnostics: McpImportDiagnostic[] }
class ImportIssue extends Error { constructor(readonly field: string, readonly code: McpImportDiagnostic['code']) { super(code); } }
function refs(value: unknown): Record<string, McpCredentialRef> {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ImportIssue('env', 'INVALID_ENTRY');
  return Object.fromEntries(Object.entries(value).map(([key, raw]) => {
    const match = typeof raw === 'string' ? /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(raw) : null;
    if (!match) throw new ImportIssue('env', 'REFERENCE_REQUIRED'); return [key, `env:${match[1]}` as McpCredentialRef];
  }));
}
/** Declarative mapping only. Never calls Pi's command/env value resolver or reads ~/.pi. */
function transport(entry: PiServerConfig) {
  if ('command' in entry && !('url' in entry)) {
    if (entry.type !== undefined && entry.type !== 'stdio') throw new ImportIssue('type', 'INVALID_ENTRY');
    if ('headers' in entry) throw new ImportIssue('headers', 'UNSUPPORTED_FIELD');
    return { type: 'stdio', command: entry.command, ...(entry.args === undefined ? {} : { args: entry.args }),
      ...(entry.cwd === undefined ? {} : { cwd: entry.cwd }), envRefs: refs(entry.env) };
  }
  if ('url' in entry && !('command' in entry)) {
    if (entry.type !== undefined && !['http', 'streamable-http'].includes(entry.type)) throw new ImportIssue('type', 'INVALID_ENTRY');
    if (['env', 'args', 'cwd'].some(k => Object.hasOwn(entry, k))) throw new ImportIssue('transport', 'INVALID_ENTRY');
    let auth: unknown = { type: 'none' };
    if (entry.headers !== undefined) {
      const values = entry.headers;
      if (!values || typeof values !== 'object' || Array.isArray(values)) throw new ImportIssue('headers', 'INVALID_ENTRY');
      if (Object.keys(values).length) {
        const entries = Object.entries(values); const [key, value] = entries[0]!;
        const match = typeof value === 'string' ? /^Bearer \$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(value) : null;
        if (entries.length !== 1 || key.toLowerCase() !== 'authorization' || !match) throw new ImportIssue('headers', 'REFERENCE_REQUIRED');
        auth = { type: 'bearer', credentialRef: `env:${match[1]}` };
      }
    }
    return { type: 'streamable-http', url: entry.url, auth };
  }
  throw new ImportIssue('transport', 'INVALID_ENTRY');
}
export function previewPiMcpConfig(value: unknown): McpImportPreview {
  const result: McpImportPreview = { configs: [], diagnostics: [] };
  let entries: [string, unknown][];
  try {
    const source = object(jsonCopy(value), ['mcpServers'], 'config');
    if (!source.mcpServers || typeof source.mcpServers !== 'object' || Array.isArray(source.mcpServers)) throw 0;
    entries = Object.entries(source.mcpServers); if (entries.length > 128) throw 0;
  } catch { return { configs: [], diagnostics: [{ index: -1, field: 'config', code: 'INVALID_ENTRY' }] }; }
  for (const [index, [name, raw]] of entries.entries()) {
    try {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ImportIssue('server', 'INVALID_ENTRY');
      const allowed = ['type', 'command', 'args', 'cwd', 'env', 'url', 'headers', 'enabled', 'timeout'];
      if (Object.keys(raw).some(k => !allowed.includes(k))) throw new ImportIssue('server', 'UNSUPPORTED_FIELD');
      const entry = raw as PiServerConfig;
      const timeout = entry.timeout === undefined ? undefined : typeof entry.timeout === 'number' ? entry.timeout * 1000 : NaN;
      result.configs.push(parseMcpServerConfig({ format: 'dreamedge-mcp-server/v1', serverId: name, displayName: name,
        configRevision: 1, enabled: entry.enabled === undefined ? true : entry.enabled, transport: transport(entry),
        ...(timeout === undefined ? {} : { requestTimeoutMs: timeout }), policy: { connect: 'ask', tools: 'ask', resources: 'ask' } }));
    } catch (error) {
      result.diagnostics.push({ index, field: error instanceof ImportIssue ? error.field : error instanceof McpConfigError ? error.field : 'server',
        code: error instanceof ImportIssue ? error.code : 'INVALID_ENTRY' });
    }
  }
  return freezeDeep(result);
}
