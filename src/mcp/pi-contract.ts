import { LATEST_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from '@earendil-works/pi-mcp';
import type { McpClientOptions } from '@earendil-works/pi-mcp';
import { parseMcpServerConfig } from './config.js';
import type { McpServerConfig } from './types.js';
export const piMcpVersion = '1.1.0';
export const mcpProtocolBaseline = LATEST_PROTOCOL_VERSION;
export const mcpSupportedProtocols = Object.freeze([...SUPPORTED_PROTOCOL_VERSIONS]);
/** Client metadata only. Transport creation and host authorization belong to later stages. */
export function mcpClientOptions(value: McpServerConfig): McpClientOptions {
  const config = parseMcpServerConfig(value);
  return { name: 'dreamedge', version: '0.0.1', protocolVersion: config.protocolVersion,
    requestTimeoutMs: config.requestTimeoutMs, capabilities: {} };
}
