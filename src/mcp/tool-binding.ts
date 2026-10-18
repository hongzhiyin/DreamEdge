import { toLlmContent } from '@earendil-works/pi-mcp';
import type { CallToolResult, McpRequestOptions } from '@earendil-works/pi-mcp';
import type { JsonObject, JsonValue } from '@earendil-works/pi-ai';
import type { McpConnectionView, McpCatalogTool } from './connection-types.js';
import type { ToolDefinition, ToolExecutionContext, ToolSnapshot } from '../tools/types.js';
import { mcpToolOrigin } from '../tools/mcp-origin.js';
import { argumentsDigest, freezeDeep, jsonCopy } from '../tools/json.js';
import { toolSnapshot } from '../tools/snapshot.js';
import { mcpExecutionCheck } from './execution-check.js';
import { McpConnectionError } from './connection-errors.js';

export interface McpRunScope {
  readonly sessionId: string;
  readonly runId: string;
  readonly signal: AbortSignal;
  /** Checks the persisted running intent and exact approval, not merely an approval ID. */
  authorize(snapshot: ToolSnapshot, args: JsonObject, context: ToolExecutionContext): boolean;
  /** Host-owned receipt from explicit scoped reading consent, never inferred from server annotations. */
  readGrant?: { digest: string; toolSchemas: Readonly<Record<string, string>>; interactionTools?: readonly string[]; check(): void };
}
export function mcpToolAlias(serverId: string, toolName: string): string {
  return `mcp_${argumentsDigest({ serverId, toolName }).slice(0, 60)}`;
}

/** Only managed connections provide these callbacks; callers never receive a raw Client. */
export function bindMcpTool(view: McpConnectionView, connectionId: string, item: McpCatalogTool,
  timeoutMs: number, scope: McpRunScope, check: () => void,
  call: (name: string, args: JsonObject, options: McpRequestOptions, check: () => void) => Promise<CallToolResult>): ToolDefinition {
  if (!view.catalog || item.availability !== 'compatible') throw new McpConnectionError('INVALID_CATALOG');
  const read = scope.readGrant;
  const interaction = read?.interactionTools?.includes(item.definition.name) === true;
  if (read && read.toolSchemas[item.definition.name] !== item.schemaDigest) throw new McpConnectionError('APPROVAL_REQUIRED');
  const origin = mcpToolOrigin({ kind: 'mcp', ...view.identity, connectionId,
    catalogRevision: view.catalog.revision, catalogDigest: view.catalog.digest,
    protocolVersion: view.catalog.protocolVersion, toolName: item.definition.name, schemaDigest: item.schemaDigest,
    ...(read ? interaction ? { interactionGrantDigest: read.digest } : { readGrantDigest: read.digest } : {}) });
  const snapshot = toolSnapshot({ origin, name: mcpToolAlias(origin.serverId, origin.toolName),
    version: `mcp-${argumentsDigest(origin)}`, label: `${origin.serverId} / ${origin.toolName}`,
    description: item.definition.description?.trim() || `MCP tool: ${origin.toolName}`,
    parameters: item.definition.inputSchema, effect: read && !interaction ? 'read' : 'write', approval: read && !interaction ? 'never' : 'always',
    resources: [`mcp:${origin.serverId}`], timeoutMs });
  const used = new Set<string>();
  return { ...snapshot, awaitCancellation: true,
    ...(interaction ? { inspectExecution: async () => {
      check(); read!.check();
      return { decision: 'allow' as const, rule: 'application-interaction/v1', reason: '此操作在本机会话交互授权范围内。' };
    } } : {}), async execute(input, context) {
    const args = input as JsonObject;
    const checkInvocation = mcpExecutionCheck(scope, snapshot, args, context, () => { check(); read?.check(); }, used);
    // No awaits between the final host check and handing the request to Pi.
    const result = await call(origin.toolName, args, { signal: AbortSignal.any([scope.signal, context.signal]),
      timeoutMs, onProgress: () => { /* Pi consumes protocol progress; it never changes the approval or deadline. */ } }, checkInvocation);
    context.signal.throwIfAborted(); scope.signal.throwIfAborted(); read?.check();
    const raw = jsonCopy({ content: result.content, ...(result.structuredContent ? { structuredContent: result.structuredContent } : {}),
      ...(result.isError === undefined ? {} : { isError: result.isError }) });
    if (Buffer.byteLength(JSON.stringify(raw), 'utf8') > 512 * 1024) throw new McpConnectionError('LIMIT_EXCEEDED');
    return freezeDeep({ effectState: result.isError ? 'unknown' as const : 'committed' as const,
      isError: result.isError === true, content: toLlmContent(result),
      details: { mcp: { origin, result: raw } } as unknown as JsonValue });
  } };
}
