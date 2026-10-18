import { LATEST_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from '@earendil-works/pi-mcp';
import type { SupportedProtocolVersion } from '@earendil-works/pi-mcp';
import { argumentsDigest, freezeDeep, jsonCopy } from '../tools/json.js';
import type { McpConnectionIdentity, McpPermissionPolicy, McpServerConfig } from './types.js';
import { parseMcpTransport } from './transport-config.js';
import { id, integer, invalid, object, string } from './validation.js';

function policy(value: unknown): McpPermissionPolicy {
  const source = object(value, ['connect', 'tools', 'resources'], 'policy');
  for (const key of ['connect', 'tools', 'resources']) if (typeof source[key] !== 'string' || !['ask', 'deny'].includes(source[key] as string)) invalid(`policy.${key}`);
  return { connect: source.connect as 'ask' | 'deny', tools: source.tools as 'ask' | 'deny', resources: source.resources as 'ask' | 'deny' };
}
/** Pure parsing: does not read credentials, inspect applications, launch processes or connect. */
export function parseMcpServerConfig(value: unknown): McpServerConfig {
  let copied: unknown;
  try { copied = jsonCopy(value); } catch { return invalid('config'); }
  const source = object(copied, ['format', 'serverId', 'displayName', 'configRevision', 'enabled', 'protocolVersion',
    'requestTimeoutMs', 'transport', 'policy'], 'config');
  if (source.format !== 'dreamedge-mcp-server/v1') invalid('format');
  if (typeof source.enabled !== 'boolean') invalid('enabled');
  const protocol = source.protocolVersion ?? LATEST_PROTOCOL_VERSION;
  if (!SUPPORTED_PROTOCOL_VERSIONS.includes(protocol as SupportedProtocolVersion)) invalid('protocolVersion');
  const displayName = string(source.displayName, 'displayName', 200).trim(); if (!displayName) invalid('displayName');
  return freezeDeep({ format: 'dreamedge-mcp-server/v1', serverId: id(source.serverId, 'serverId'), displayName,
    configRevision: integer(source.configRevision, 'configRevision'), enabled: source.enabled,
    protocolVersion: protocol as SupportedProtocolVersion, requestTimeoutMs: integer(source.requestTimeoutMs ?? 30_000, 'requestTimeoutMs', 2_147_483_647),
    transport: parseMcpTransport(source.transport), policy: policy(source.policy) });
}
export function mcpConnectionIdentity(value: McpServerConfig): McpConnectionIdentity {
  const config = parseMcpServerConfig(value);
  return Object.freeze({ serverId: config.serverId, configRevision: config.configRevision, configDigest: argumentsDigest(config) });
}
