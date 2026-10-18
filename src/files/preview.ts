import type { MutationPreview } from './mutation-types.js';
import type { OperationPreview } from './operation-types.js';
export type FilePreview = MutationPreview | OperationPreview;
export const previewPaths = (p: FilePreview): string[] => p.kind === 'file_operation' && p.destination
  ? [p.path, p.destination.binding.path] : [p.path];
export const operationLabels = { create: '新建文件', overwrite: '覆盖文件', edit: '编辑文件',
  trash: '移到废纸篓', delete: '永久删除', move: '移动', copy: '复制', mkdir: '创建目录' };
export const previewBytes = (p: FilePreview) => p.kind === 'file_mutation' ? p.afterBytes : p.tree?.bytes ?? 0;
export function previewDescription(p: FilePreview): string {
  if (p.kind === 'file_mutation') return p.patch;
  return [operationLabels[p.operation], p.path, ...(p.destination ? [`目标：${p.destination.binding.path}`] : []),
    ...(p.operation === 'delete' ? ['永久删除，不能从废纸篓恢复。'] : []),
    ...(p.tree?.entries.map(entry => `${entry.kind === 'directory' ? '目录' : '文件'} ${entry.relative || '.'}${entry.kind === 'file' ? `（${entry.size} 字节）` : ''}`) ?? [])].join('\n');
}
