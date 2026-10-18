import { toLlmContent } from '@earendil-works/pi-mcp';
import type { ReadResourceResult } from '@earendil-works/pi-mcp';
import type { JsonValue } from '@earendil-works/pi-ai';
import type { ToolResult } from '../tools/types.js';
import type { McpToolOrigin } from '../tools/mcp-origin.js';
import type { ModelDestination } from '../model/destination.js';
import { argumentsDigest, freezeDeep, jsonCopy } from '../tools/json.js';
import { McpConnectionError } from './connection-errors.js';

export const MCP_RESOURCE_BYTES = 512 * 1024;
export interface McpResourceReceipt {
  format: 'dreamedge-mcp-resource/v1'; origin: McpToolOrigin; uri: string;
  destination: ModelDestination; capturedAt: number; contentDigest: string;
  result: ReadResourceResult;
}
/** The requested resource can contain several returned parts; none of their URIs are followed. */
export function resourcePayload(result: ReadResourceResult): ReadResourceResult {
  if (!result || !Array.isArray(result.contents) || result.contents.length > 64
    || Buffer.byteLength(JSON.stringify(result), 'utf8') > MCP_RESOURCE_BYTES) throw new McpConnectionError('LIMIT_EXCEEDED');
  const contents = result.contents.map(item => {
    if (!item || typeof item.uri !== 'string' || !item.uri || item.uri.length > 4096
      || (item.mimeType !== undefined && (typeof item.mimeType !== 'string' || item.mimeType.length > 256))) throw new McpConnectionError('INVALID_CATALOG');
    const base = { uri: item.uri, ...(item.mimeType === undefined ? {} : { mimeType: item.mimeType }) };
    if ('text' in item && typeof item.text === 'string' && !('blob' in item)) return { ...base, text: item.text };
    if ('blob' in item && typeof item.blob === 'string' && !('text' in item)
      && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(item.blob)) return { ...base, blob: item.blob };
    throw new McpConnectionError('INVALID_CATALOG');
  });
  return { contents };
}
export function resourceContent(result: ReadResourceResult) {
  return result.contents.length ? toLlmContent({ content: result.contents.map(resource => ({ type: 'resource' as const, resource })) })
    : [{ type: 'text' as const, text: 'MCP 资源为空。' }];
}
export function mcpResourceResult(origin: McpToolOrigin, uri: string, destination: ModelDestination,
  result: ReadResourceResult): ToolResult {
  const payload = resourcePayload(result);
  const receipt: McpResourceReceipt = { format: 'dreamedge-mcp-resource/v1', origin, uri, destination,
    capturedAt: Date.now(), result: payload, contentDigest: argumentsDigest(payload) };
  return freezeDeep({ content: resourceContent(payload), details: { mcpResource: jsonCopy(receipt) } as JsonValue });
}
