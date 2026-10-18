import { join } from 'node:path';
import { ReaderStore } from '../../reading/store.js';
import { readerVersion } from '../../reading/protocol.js';
import { modelDestination } from '../../model/destination.js';
import { canonicalJson } from '../../tools/json.js';
import { ModelAdapterError } from '../../model/errors.js';
import type { HostAdapter } from '../types.js';

/** Read-only migration adapter. Never starts the legacy CLI or grants replacement MCP access. */
export function legacyReadingAdapter(directory: string): HostAdapter {
  let store: ReaderStore | undefined, invalid = false;
  try { store = new ReaderStore(join(directory, 'reading.local.json')); } catch { invalid = true; }
  return {
    id: 'recollection-garden-legacy',
    notice: (sessionId, runs) => invalid || store?.binding(sessionId) || runs.some(r => r.toolsSnapshot?.some(t => t.version === readerVersion))
      ? '此会话保留旧阅读器记录。原专用绑定已停用，请选择该应用提供的标准 MCP 连接；旧记录不会转成新授权。' : undefined,
    guardHistory(runs, config) {
      if (runs.some(run => run.toolsSnapshot?.some(tool => tool.version === readerVersion)
        && canonicalJson(modelDestination(run.modelConfigSnapshot)) !== canonicalJson(modelDestination(config)))) {
        throw new ModelAdapterError('INVALID_CONTEXT', '历史外部内容仅授权原模型目的地，请新建空对话。');
      }
    },
  };
}
