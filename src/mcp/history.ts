import type { RunRecord } from '../conversation/types.js';
import type { ModelConnectionConfig } from '../model/types.js';
import { modelDestination } from '../model/destination.js';
import { ModelAdapterError } from '../model/errors.js';
import { canonicalJson } from '../tools/json.js';
import type { McpConnectionManager } from './connection-manager.js';

/** Also protects assistant paraphrases derived from external data, not just toolResult blocks. */
export function checkMcpHistory(manager: McpConnectionManager, runs: readonly RunRecord[],
  config: ModelConnectionConfig, current: ModelConnectionConfig): void {
  try {
    const target = canonicalJson(modelDestination(config));
    if (target !== canonicalJson(modelDestination(current))) throw new Error('Destination changed');
    const checked = new Set<string>();
    for (const run of runs) {
      const origins = run.toolsSnapshot?.flatMap(tool => tool.origin ? [tool.origin] : []) ?? [];
      if (!origins.length) continue;
      if (target !== canonicalJson(modelDestination(run.modelConfigSnapshot))) throw new Error('History destination changed');
      for (const origin of origins) {
        const key = canonicalJson([run.sessionId, origin.kind, origin.serverId, origin.configRevision, origin.configDigest]);
        if (!checked.has(key)) { manager.assertHistory(run.sessionId, origin); checked.add(key); }
      }
    }
  } catch { throw new ModelAdapterError('INVALID_CONTEXT', '历史 MCP 内容的连接授权或模型目的地已改变；请恢复有效的原连接，或新建空对话。'); }
}
