import { guardLegacyExternal } from './legacy-external.js';
import type { ModelConnectionConfig } from '../model/types.js';
import type { RunRecord } from './types.js';
import type { PrepareRunTools } from './prepared-tools.js';
import { ModelAdapterError } from '../model/errors.js';

/** Missing host integration must not turn persisted external content into unrestricted model context. */
export function guardExternalHistory(runs: readonly RunRecord[], config: ModelConnectionConfig,
  current: ModelConnectionConfig, prepare?: PrepareRunTools): void {
  guardLegacyExternal(runs, config, current);
  if (!runs.some(run => run.toolsSnapshot?.some(tool => tool.origin))) return;
  if (!prepare?.guardHistory) throw new ModelAdapterError('INVALID_CONTEXT', '历史外部内容缺少当前权限核验；请接入原连接或新建对话。');
  prepare.guardHistory(runs, config, current);
}
