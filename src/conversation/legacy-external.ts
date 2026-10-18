import type { RunRecord } from './types.js';
import { modelDestination } from '../model/destination.js';
import type { ModelConnectionConfig } from '../model/types.js';
import { canonicalJson } from '../tools/json.js';
import { ModelAdapterError } from '../model/errors.js';
const localResources = new Set(['clock', 'calculator', 'filesystem']);
/** Old third-party tools have no MCP origin. Their resource categories still identify external history. */
export function hasLegacyExternalData(runs: readonly RunRecord[]): boolean {
  return runs.some(run => run.toolsSnapshot?.some(tool => !tool.origin && tool.resources.some(resource => !localResources.has(resource))));
}
export function guardLegacyExternal(runs: readonly RunRecord[], config: ModelConnectionConfig, current: ModelConnectionConfig) {
  const destination = canonicalJson(modelDestination(config));
  if (runs.some(run => hasLegacyExternalData([run]) && (destination !== canonicalJson(modelDestination(run.modelConfigSnapshot))
    || destination !== canonicalJson(modelDestination(current))))) {
    throw new ModelAdapterError('INVALID_CONTEXT', '历史外部内容仅授权原模型目的地，请新建空对话。');
  }
}
