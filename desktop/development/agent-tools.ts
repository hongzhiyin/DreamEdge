import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';
import type { ModelAccess } from './model';

export function projectTools(access: ModelAccess, signal: AbortSignal, beforeExpose: (value: unknown) => void): AgentTool[] {
  const directory = Type.String({ maxLength: 1024, description: 'Directory relative to src; empty string for the source root.' });
  const definitions = [
    { name: 'list_files', label: '查看目录', description: 'List source paths in the current project, 100 per page. No file contents.',
      parameters: Type.Object({ directory, offset: Type.Integer({ minimum: 0 }) }, { additionalProperties: false }) },
    { name: 'read_file', label: '读取文件', description: 'Read the complete UTF-8 source file before modifying it. Path is relative to src.',
      parameters: Type.Object({ path: Type.String({ minLength: 1, maxLength: 1024 }) }, { additionalProperties: false }) },
    { name: 'search_files', label: '搜索源码', description: 'Find literal text in source files, returning paths and line excerpts. Not a regular expression.',
      parameters: Type.Object({ directory, query: Type.String({ minLength: 1, maxLength: 160 }) }, { additionalProperties: false }) },
  ];
  return definitions.map(tool => ({ ...tool, executionMode: 'sequential', execute: async (_id, args, activeSignal) => {
    const combined = activeSignal ? AbortSignal.any([signal, activeSignal]) : signal;
    combined.throwIfAborted();
    const result = await access.execute(tool.name, args as Record<string, unknown>, combined, beforeExpose);
    combined.throwIfAborted(); beforeExpose(result);
    return { content: [{ type: 'text', text: JSON.stringify(result) }], details: {} };
  } }));
}
