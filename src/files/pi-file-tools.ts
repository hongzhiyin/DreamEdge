import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import type { JsonObject } from '@earendil-works/pi-ai';
import type { TSchema } from 'typebox';
import type { ToolDefinition, ToolExecutionContext } from '../tools/types.js';
import { canonicalJson, freezeDeep, jsonCopy } from '../tools/json.js';
import { validateToolArguments } from '../tools/schema.js';
import { toolSnapshot } from '../tools/snapshot.js';
import { cleanToolResult } from '../tools/result.js';
import { piDetails, piParameters } from './pi-json.js';

export const piFileToolNames = ['read', 'ls', 'find', 'grep', 'write', 'edit'] as const;
export type PiFileToolName = typeof piFileToolNames[number];
export interface PiFileInvocation {
  readonly tool: AgentTool;
  /** Host-only translation, for example an authorized grep snapshot path. */
  readonly args?: JsonObject;
  dispose?(): Promise<void>;
}
export interface PiFileToolHost {
  authorize(name: PiFileToolName, args: JsonObject, context: ToolExecutionContext): Promise<void>;
  prepare(name: PiFileToolName, args: JsonObject, context: ToolExecutionContext): Promise<PiFileInvocation>;
}
const labels = { read: '读取文件', ls: '列出目录', find: '查找文件', grep: '搜索内容', write: '写入文件', edit: '编辑文件' };
const denied = async (): Promise<never> => { throw new Error('File operations are not bound'); };
const normalize = (result: AgentToolResult<unknown>) => {
  if (!result || (result.isError !== undefined && typeof result.isError !== 'boolean')) throw new Error('Invalid Pi result');
  if (result.isError) throw new Error('Pi 文件工具返回失败。');
  if (result.terminate) throw new Error('文件工具不能控制 Agent 执行循环。');
  return cleanToolResult({ content: result.content, details: piDetails(result.details) });
};

/** Lazy loading keeps coding-agent imports off the normal desktop startup path. */
export async function loadPiFileTools(host: PiFileToolHost): Promise<readonly ToolDefinition[]> {
  if (!host || typeof host.authorize !== 'function' || typeof host.prepare !== 'function') throw new Error('文件工具需要显式宿主授权与执行绑定。');
  const authorize = host.authorize.bind(host); const prepare = host.prepare.bind(host);
  const pi = await import('@earendil-works/pi-coding-agent');
  // These instances supply schemas only. Default filesystem executors are never dispatched.
  const source: Record<PiFileToolName, AgentTool> = {
    read: pi.createReadTool('/', { operations: { readFile: denied, access: denied, detectImageMimeType: denied } }),
    ls: pi.createLsTool('/', { operations: { exists: denied, stat: denied, readdir: denied } }),
    find: pi.createFindTool('/', { operations: { exists: denied, glob: denied } }),
    grep: pi.createGrepTool('/', { operations: { isDirectory: denied, readFile: denied } }),
    write: pi.createWriteTool('/', { operations: { mkdir: denied, writeFile: denied } }),
    edit: pi.createEditTool('/', { operations: { access: denied, readFile: denied, writeFile: denied } }),
  };
  return Object.freeze(piFileToolNames.map(name => {
    const parameters = piParameters(source[name].parameters) as TSchema;
    const definition: ToolDefinition = { name, label: labels[name], description: source[name].description,
      version: 'pi-1.1.0/adapter-1', parameters, effect: name === 'write' || name === 'edit' ? 'write' : 'read',
      approval: name === 'write' || name === 'edit' ? 'always' : 'never', resources: ['filesystem'], timeoutMs: 30_000,
      async execute(input, context) {
        const args = validateToolArguments(snapshot, input); const signal = context.signal;
        signal.throwIfAborted(); await authorize(name, structuredClone(args), context); signal.throwIfAborted();
        const invocation = await prepare(name, structuredClone(args), context);
        let finished = false; let updates = Promise.resolve(); let updateError: unknown;
        const local = new AbortController(); const executionSignal = AbortSignal.any([signal, local.signal]);
        try {
          signal.throwIfAborted();
          if (!invocation?.tool || invocation.tool.name !== name || typeof invocation.tool.execute !== 'function'
            || canonicalJson(piParameters(invocation.tool.parameters)) !== canonicalJson(snapshot.parameters)) throw new Error('Pi 文件工具绑定不匹配。');
          const actual = validateToolArguments(snapshot, invocation.args ?? args);
          const { path: _originalPath, ...before } = args; const { path: _boundPath, ...after } = actual;
          if (canonicalJson(before) !== canonicalJson(after)) throw new Error('宿主绑定只能转换文件路径，不能改写调用内容。');
          const result = await invocation.tool.execute(context.toolCallId, jsonCopy(actual) as JsonObject, executionSignal, update => {
            if (finished || executionSignal.aborted) return;
            updates = updates.then(async () => {
              if (!finished && !executionSignal.aborted) await context.onUpdate?.(normalize(update));
            }).catch(error => { updateError = error; local.abort(); });
          });
          await updates; if (updateError) throw new Error('文件工具更新处理失败。');
          signal.throwIfAborted(); return normalize(result);
        } finally { finished = true; await invocation?.dispose?.(); }
      } };
    const snapshot = toolSnapshot(definition);
    return freezeDeep(definition);
  }));
}
