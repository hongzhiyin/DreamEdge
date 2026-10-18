import type { McpRequestOptions, ReadResourceResult } from '@earendil-works/pi-mcp';
import type { JsonObject } from '@earendil-works/pi-ai';
import type { ToolDefinition } from '../tools/types.js';
import type { ModelDestination } from '../model/destination.js';
import { mcpOriginAlias, mcpToolOrigin } from '../tools/mcp-origin.js';
import { argumentsDigest } from '../tools/json.js';
import { toolSnapshot } from '../tools/snapshot.js';
import { validateToolArguments } from '../tools/schema.js';
import type { McpConnectionView } from './connection-types.js';
import type { McpRunScope } from './tool-binding.js';
import { mcpExecutionCheck } from './execution-check.js';
import { mcpResourceResult } from './resource-result.js';

export function bindMcpResources(view: McpConnectionView, connectionId: string, timeoutMs: number,
  destination: ModelDestination, scope: McpRunScope, check: () => void,
  read: (uri: string, options: McpRequestOptions, check: () => void) => Promise<ReadResourceResult>): ToolDefinition[] {
  const catalog = view.catalog;
  if (!catalog || catalog.resourceDiscovery !== 'available' || !catalog.resources.length) return [];
  const parameters = { type: 'object', properties: { uri: { type: 'string', enum: catalog.resources.map(r => r.uri) } },
    required: ['uri'], additionalProperties: false };
  const origin = mcpToolOrigin({ kind: 'mcp-resource', ...view.identity, connectionId,
    catalogRevision: catalog.revision, catalogDigest: catalog.digest, protocolVersion: catalog.protocolVersion,
    toolName: 'resources/read', schemaDigest: argumentsDigest(parameters) });
  const snapshot = toolSnapshot({ origin, name: mcpOriginAlias(origin), version: `mcp-${argumentsDigest(origin)}`,
    label: `${origin.serverId} / 读取资源`, description: `Read one explicitly approved MCP resource. Resource catalog: ${JSON.stringify(catalog.resources.map(r => ({ uri: r.uri, name: r.name })))}`,
    parameters, effect: 'read', approval: 'always', timeoutMs, resources: [`mcp:${origin.serverId}`] });
  const used = new Set<string>(); const target = structuredClone(destination);
  return [{ ...snapshot, awaitCancellation: true, async execute(input, context) {
    const args = validateToolArguments(snapshot, input) as JsonObject;
    const invocation = mcpExecutionCheck(scope, snapshot, args, context, check, used);
    const result = await read(args.uri as string, { signal: AbortSignal.any([scope.signal, context.signal]), timeoutMs }, invocation);
    context.signal.throwIfAborted(); scope.signal.throwIfAborted(); check();
    return mcpResourceResult(origin, args.uri as string, target, result);
  } }];
}
