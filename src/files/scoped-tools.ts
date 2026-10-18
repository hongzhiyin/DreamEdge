import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { JsonObject } from '@earendil-works/pi-ai';
import type { ToolDefinition, ToolExecutionContext } from '../tools/types.js';
import type { FileScopeService } from './scope-service.js';
import type { PiFileToolHost } from './pi-file-tools.js';
import { loadPiFileTools } from './pi-file-tools.js';
import { readToolNames, validateReadOptions, readLimits } from './read-limits.js';
import type { ReadLimits, ReadToolName } from './read-limits.js';
import { createReadSnapshot } from './read-snapshot.js';
import type { ReadSnapshot } from './read-snapshot.js';
import { runReadWorker } from './read-worker.js';
import { freezeDeep } from '../tools/json.js';
import { FileScopeError } from './scope-types.js';

/** Pi still owns formatting, glob output, regex matching, text windows and truncation. */
export async function scopedReadTools(scopes: FileScopeService, options: Partial<ReadLimits> = {}, cacheRoot?: string,
  accessMode: 'scoped' | 'account' = 'scoped'): Promise<readonly ToolDefinition[]> {
  const limits = readLimits(options); const pi = await import('@earendil-works/pi-coding-agent');
  const host: PiFileToolHost = {
    async authorize(name, args) {
      if (!readToolNames.includes(name as ReadToolName)) throw new FileScopeError('FILE_SCOPE_DENIED', '尚未开放文件写入与编辑。');
      validateReadOptions(name as ReadToolName, args);
    },
    async prepare(name, args, context) {
      const binding = await scopes.bindRead(context, typeof args.path === 'string' ? args.path : '.');
      const snapshot = await createReadSnapshot(scopes, binding, name as ReadToolName, context.signal, limits, cacheRoot);
      const factories = { read: pi.createReadTool, ls: pi.createLsTool, find: pi.createFindTool, grep: pi.createGrepTool };
      const original: AgentTool = factories[name as ReadToolName](snapshot.root);
      const tool: AgentTool = { ...original, execute: async (_id, actual, signal) => {
        const result = await runReadWorker(snapshot, name as ReadToolName, actual as JsonObject, signal ?? context.signal);
        await scopes.verify(binding); (signal ?? context.signal).throwIfAborted();
        for (const item of snapshot.observations) item.observation.complete = name === 'read'
          && args.offset === undefined && args.limit === undefined && !(result.details as JsonObject | undefined)?.truncation;
        scopes.recordObservations(snapshot.observations);
        const content = result.content.map(block => block.type === 'text'
          ? { type: 'text' as const, text: block.text.split(snapshot.target).join(binding.path).split(snapshot.root).join(binding.path) } : block);
        if (snapshot.skipped) content.push({ type: 'text', text: `已排除 ${snapshot.skipped} 项无访问权限、链接或无法安全显示的项目。` });
        return { content, details: { ...(result.details as JsonObject ?? {}), fileAccess: {
          format: 'dreamedge-file-result/v1', grantId: binding.grantId, rootId: binding.rootId,
          policyVersion: binding.policyVersion, destination: binding.destination, path: binding.path,
          entries: snapshot.entries, bytes: snapshot.bytes, skipped: snapshot.skipped,
          files: snapshot.observations.map(item => ({ path: item.observation.path, version: item.observation.version, complete: item.observation.complete })),
        } } };
      } };
      return { tool, args: { ...args, path: snapshot.target }, dispose: () => snapshot.dispose() };
    },
  };
  const tools = (await loadPiFileTools(host)).filter(tool => readToolNames.includes(tool.name as ReadToolName));
  return Object.freeze(tools.map(tool => freezeDeep({ ...tool, version: 'pi-1.1.0/scoped-read-1', awaitCancellation: true, timeoutMs: limits.timeoutMs,
    description: `${tool.description} ${accessMode === 'account'
      ? 'Use OS account file access without choosing directories. Relative paths use the account home. Known credential exclusions remain enforced.'
      : 'Only authorized session directories are readable. Multiple roots require absolute paths.'} Input scan limits apply; narrow large searches to relevant paths.`,
    execute: async (args: JsonObject, context: ToolExecutionContext) => {
      const deadline = AbortSignal.timeout(limits.timeoutMs);
      return tool.execute(args, { ...context, signal: AbortSignal.any([context.signal, deadline]) });
    } })));
}
