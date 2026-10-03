import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type, type TSchema } from 'typebox';
import { Check } from 'typebox/value';
import { proposalSchema, type ModelAccess } from './model';

export function projectTools(access: ModelAccess, signal: AbortSignal, beforeExpose: (value: unknown) => void,
  submitted: (proposal: Record<string, unknown>) => void, commitAllowed = false): AgentTool[] {
  const directory = Type.String({ maxLength: 1024, description: 'Directory relative to src; empty string for the source root.' });
  const definitions: { name: string; label: string; description: string; parameters: TSchema }[] = [
    { name: 'list_files', label: '查看目录', description: 'List source paths in the current project, 100 per page. No file contents.',
      parameters: Type.Object({ directory, offset: Type.Integer({ minimum: 0 }) }, { additionalProperties: false }) },
    { name: 'read_file', label: '读取文件', description: 'Read the complete UTF-8 source file before modifying it. Path is relative to src.',
      parameters: Type.Object({ path: Type.String({ minLength: 1, maxLength: 1024 }) }, { additionalProperties: false }) },
    { name: 'search_files', label: '搜索源码', description: 'Find literal text in source files, returning paths and line excerpts. Not a regular expression.',
      parameters: Type.Object({ directory, query: Type.String({ minLength: 1, maxLength: 160 }) }, { additionalProperties: false }) },
    { name: 'propose_changes', label: '提交候选修改', description: 'Finish this turn by submitting a summary and complete candidate source file contents. Read existing files first. Use files: [] for a reply without edits. This stages a proposal, never saves source.',
      parameters: Type.Unsafe(proposalSchema) },
  ];
  if (commitAllowed) definitions.push({ name: 'git_commit', label: '提交 Git', description: 'Queue a Git commit after this turn is successfully built and applied. Provide a concise message, then finish using propose_changes. No remote push.',
    parameters: Type.Object({ message: Type.String({ minLength: 1, maxLength: 500 }) }, { additionalProperties: false }) });
  return definitions.map(tool => ({ ...tool, constrainedSampling: { type: 'json_schema' as const, strict: 'require' as const },
    prepareArguments: args => {
      if (!Check(tool.parameters, args)) throw new Error('工具参数不符合声明的格式，请按 schema 重新提交。');
      return args;
    },
    executionMode: 'sequential', execute: async (_id, args, activeSignal) => {
    const combined = activeSignal ? AbortSignal.any([signal, activeSignal]) : signal;
    combined.throwIfAborted();
    let result: unknown;
    try { result = await access.execute(tool.name, args as Record<string, unknown>, combined, beforeExpose); }
    catch (error) {
      if ((error as NodeJS.ErrnoException)?.code) throw new Error('工程文件读取失败，请检查文件是否存在且为普通文本。');
      throw error;
    }
    combined.throwIfAborted(); beforeExpose(result);
    if (tool.name === 'propose_changes') submitted(args as Record<string, unknown>);
    return { content: [{ type: 'text', text: JSON.stringify(result) }], details: {}, terminate: tool.name === 'propose_changes' };
  } }));
}
