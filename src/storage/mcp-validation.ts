import { toLlmContent } from '@earendil-works/pi-mcp';
import type { CallToolResult } from '@earendil-works/pi-mcp';
import type { RunRecord } from '../conversation/types.js';
import type { McpResourceReceipt } from '../mcp/resource-result.js';
import { resourcePayload, resourceContent, MCP_RESOURCE_BYTES } from '../mcp/resource-result.js';
import { modelDestination } from '../model/destination.js';
import { argumentsDigest, canonicalJson } from '../tools/json.js';
import { SessionStoreError } from './types.js';

function invalid(): never { throw new SessionStoreError('INVALID_DATA', 'MCP 来源或资源结果记录无效。'); }
/** Durable receipts are matched to their requested operation and original recipient. */
export function validateMcpData(run: RunRecord): void {
  for (const entry of run.transcript ?? []) {
    const message = entry.message; if (message.role !== 'toolResult') continue;
    const call = run.toolCalls?.find(call => call.toolCallId === message.toolCallId);
    const origin = run.toolsSnapshot?.find(tool => tool.name === call?.toolName)?.origin;
    const details = message.details as { mcpResource?: McpResourceReceipt; mcp?: { origin: unknown; result: CallToolResult } } | undefined;
    if (!origin) { if (details?.mcpResource || details?.mcp) invalid(); continue; }
    if (origin.kind === 'mcp-resource') {
      if (details?.mcp) invalid();
      const receipt = details?.mcpResource;
      if (!receipt) { if (call?.status === 'succeeded') invalid(); continue; }
      if (call?.status !== 'succeeded' || message.isError || receipt.format !== 'dreamedge-mcp-resource/v1'
        || receipt.uri !== call.args.uri || typeof receipt.uri !== 'string'
        || canonicalJson(receipt.origin) !== canonicalJson(origin)
        || canonicalJson(receipt.destination) !== canonicalJson(modelDestination(run.modelConfigSnapshot))
        || !Number.isFinite(receipt.capturedAt) || receipt.capturedAt < call.createdAt || receipt.capturedAt > call.finishedAt
        || receipt.contentDigest !== argumentsDigest(receipt.result)) invalid();
      const normalized = resourcePayload(receipt.result);
      if (canonicalJson(normalized) !== canonicalJson(receipt.result)
        || canonicalJson(resourceContent(normalized)) !== canonicalJson(message.content)) invalid();
      const fields = ['format', 'origin', 'uri', 'destination', 'capturedAt', 'contentDigest', 'result'];
      if (Object.keys(receipt).some(key => !fields.includes(key))) invalid();
    } else {
      if (details?.mcpResource) invalid();
      const receipt = details?.mcp;
      if (!receipt) { if (call?.status === 'succeeded') invalid(); continue; }
      if (canonicalJson(receipt.origin) !== canonicalJson(origin)
        || Buffer.byteLength(JSON.stringify(receipt.result), 'utf8') > MCP_RESOURCE_BYTES
        || (call?.status === 'succeeded' && receipt.result.isError)
        || (receipt.result.isError === true && !message.isError)
        || canonicalJson(toLlmContent(receipt.result)) !== canonicalJson(message.content)) invalid();
    }
  }
}
