import type { ConversationDependencies } from './types.js';
import type { ModelConnectionConfig } from '../model/types.js';
import { toolSetSnapshot } from '../tools/snapshot.js';
import { ConversationError } from './state.js';
import type { ToolSnapshot } from '../tools/types.js';
import { canonicalJson } from '../tools/json.js';

export function configuredTools(dependencies: ConversationDependencies, config: ModelConnectionConfig, sessionId?: string) {
  try {
    const definitions = dependencies.tools?.(config, sessionId) ?? [];
    return toolSetSnapshot(definitions, definitions.map(tool => tool.name), config,
      config.thinkingLevel ?? (config.reasoning ? 'high' : 'off'));
  } catch { throw new ConversationError('INVALID_COMMAND', '启用工具与模型能力配置不匹配。'); }
}

/** Stored definitions do not grant access to tools disabled by the current host. */
export function retryTools(dependencies: ConversationDependencies, config: ModelConnectionConfig,
  saved: readonly ToolSnapshot[], sessionId?: string): readonly ToolSnapshot[] {
  const enabled = new Map(configuredTools(dependencies, config, sessionId).map(tool => [tool.name, tool]));
  return saved.filter(tool => enabled.has(tool.name)).map(tool => {
    if (canonicalJson(tool) !== canonicalJson(enabled.get(tool.name))) {
      throw new ConversationError('INVALID_COMMAND', '重试工具的定义或版本已经改变。');
    }
    return tool;
  });
}
