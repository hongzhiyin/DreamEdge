import type { McpClient } from '@earendil-works/pi-mcp';
import type { McpCapabilityCatalog } from './connection-types.js';
import type { McpServerConfig } from './types.js';
import { parameterSchema } from '../tools/schema.js';
import { argumentsDigest, freezeDeep, jsonCopy } from '../tools/json.js';
import { McpConnectionError } from './connection-errors.js';

function unique(values: string[]): void {
  if (values.some(value => !value || value.length > 4096) || new Set(values).size !== values.length) throw new McpConnectionError('INVALID_CATALOG');
}
export async function discoverMcpCatalog(client: McpClient, config: McpServerConfig, revision: number, signal: AbortSignal): Promise<McpCapabilityCatalog> {
  const capabilities = client.serverCapabilities, serverInfo = client.serverInfo, protocolVersion = client.protocolVersion;
  if (!capabilities || !serverInfo || !protocolVersion) throw new McpConnectionError('INVALID_CATALOG');
  const resourceDiscovery: McpCapabilityCatalog['resourceDiscovery'] = config.policy.resources === 'deny' ? 'denied' : capabilities.resources ? 'available' : 'unsupported';
  const [tools, resources, resourceTemplates] = await Promise.all([
    capabilities.tools ? client.listTools({ signal }) : [],
    resourceDiscovery === 'available' ? client.listResources({ signal }) : [],
    resourceDiscovery === 'available' ? client.listResourceTemplates({ signal }) : [],
  ]);
  if (tools.length > 256 || resources.length > 128 || resourceTemplates.length > 128) throw new McpConnectionError('LIMIT_EXCEEDED');
  unique(tools.map(t => t.name)); unique(resources.map(r => r.uri)); unique(resourceTemplates.map(r => r.uriTemplate));
  const data = { protocolVersion, serverInfo, capabilities, ...(client.instructions === undefined ? {} : { instructions: client.instructions }),
    tools: tools.map(definition => {
      let availability: McpCapabilityCatalog['tools'][number]['availability'] = config.policy.tools === 'deny' ? 'denied' : 'compatible';
      if (availability !== 'denied') { try { parameterSchema(definition.inputSchema); } catch { availability = 'unsupported-schema'; } }
      return { definition, schemaDigest: argumentsDigest(definition.inputSchema), availability };
    }), resources, resourceTemplates, resourceDiscovery };
  const copied = jsonCopy(data); if (Buffer.byteLength(JSON.stringify(copied)) > 2 * 1024 * 1024) throw new McpConnectionError('LIMIT_EXCEEDED');
  return freezeDeep({ ...(copied as unknown as typeof data), revision, digest: argumentsDigest(copied) });
}
