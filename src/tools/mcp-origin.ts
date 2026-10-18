import { ToolContractError } from './errors.js';
import { argumentsDigest, freezeDeep } from './json.js';

/** Durable provenance, never a connection capability or approval. */
export interface McpToolOrigin {
  readonly kind: 'mcp' | 'mcp-resource';
  readonly serverId: string;
  readonly configRevision: number;
  readonly configDigest: string;
  readonly connectionId: string;
  readonly catalogRevision: number;
  readonly catalogDigest: string;
  readonly protocolVersion: string;
  readonly toolName: string;
  readonly schemaDigest: string;
  readonly readGrantDigest?: string;
  readonly interactionGrantDigest?: string;
}

export function mcpToolOrigin(value: McpToolOrigin): McpToolOrigin {
  const invalid = (): never => { throw new ToolContractError('INVALID_TOOL_DEFINITION', 'MCP 工具来源无效。'); };
  if (!value || !['mcp', 'mcp-resource'].includes(value.kind)) invalid();
  if (value.readGrantDigest !== undefined && (value.kind !== 'mcp' || !/^[a-f0-9]{64}$/.test(value.readGrantDigest))) invalid();
  if (value.interactionGrantDigest !== undefined && (value.kind !== 'mcp' || value.readGrantDigest !== undefined || !/^[a-f0-9]{64}$/.test(value.interactionGrantDigest))) invalid();
  for (const key of ['serverId', 'connectionId', 'protocolVersion', 'toolName'] as const) {
    if (typeof value[key] !== 'string' || !value[key].trim() || value[key].length > 1024) invalid();
  }
  for (const key of ['configDigest', 'catalogDigest', 'schemaDigest'] as const) {
    if (typeof value[key] !== 'string' || !/^[a-f0-9]{64}$/.test(value[key])) invalid();
  }
  for (const key of ['configRevision', 'catalogRevision'] as const) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 1) invalid();
  }
  return freezeDeep({ kind: value.kind, serverId: value.serverId, configRevision: value.configRevision,
    configDigest: value.configDigest, connectionId: value.connectionId, catalogRevision: value.catalogRevision,
    catalogDigest: value.catalogDigest, protocolVersion: value.protocolVersion, toolName: value.toolName,
    schemaDigest: value.schemaDigest, ...(value.readGrantDigest ? { readGrantDigest: value.readGrantDigest } : {}),
    ...(value.interactionGrantDigest ? { interactionGrantDigest: value.interactionGrantDigest } : {}) });
}

export function mcpOriginAlias(origin: Pick<McpToolOrigin, 'kind' | 'serverId' | 'toolName'>): string {
  return `${origin.kind === 'mcp' ? 'mcp' : 'mcr'}_${argumentsDigest({ serverId: origin.serverId, toolName: origin.toolName }).slice(0, 60)}`;
}
