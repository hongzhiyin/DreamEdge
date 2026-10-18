import type { OperationPreview } from './operation-types.js';
import type { ToolInspection } from '../tools/execution-policy.js';
import { sensitiveConfigurationPath } from './mutation-policy.js';
import { previewPaths } from './preview.js';
import { join } from 'node:path';
export function inspectOperation(p: OperationPreview): ToolInspection {
  const decision = (kind: ToolInspection['decision'], rule: string, reason: string): ToolInspection => ({ decision: kind, rule: `file-operations/v2/${rule}`, reason });
  if (p.operation === 'trash') return decision('ask', 'trash', '将列出的文件或目录移到系统废纸篓。');
  if (p.operation === 'delete') return decision('ask', 'permanent-delete', '永久删除完整清单，不能从废纸篓恢复。');
  const paths = previewPaths(p);
  if (paths.some(sensitiveConfigurationPath) || p.tree?.entries.some(entry =>
    paths.some(root => sensitiveConfigurationPath(join(root, entry.relative))))) {
    return decision('ask', 'configuration', '此操作涉及系统或启动配置。');
  }
  if ((p.tree?.entries.length ?? 0) >= 50) return decision('ask', 'large-tree', '此操作涉及较多文件，请核对完整清单。');
  return decision('allow', p.operation, '普通结构变更，目标不存在且不会覆盖其他文件。');
}
