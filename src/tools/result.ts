import type { ToolResult } from './types.js';
import { jsonCopy } from './json.js';

/** Copies the portable result payload; host callbacks and transport metadata never pass through. */
export function cleanToolResult(value: ToolResult): ToolResult {
  if (!value || !Array.isArray(value.content)) throw new Error('Invalid tool result');
  const content = value.content.map(block => {
    if (block.type === 'text' && typeof block.text === 'string') return { type: 'text' as const, text: block.text };
    if (block.type === 'image' && typeof block.data === 'string' && typeof block.mimeType === 'string') {
      return { type: 'image' as const, data: block.data, mimeType: block.mimeType };
    }
    throw new Error('Invalid tool content');
  });
  return { content, details: jsonCopy(value.details ?? {}) };
}
