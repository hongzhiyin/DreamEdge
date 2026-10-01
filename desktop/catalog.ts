import readingLog from '../tools/reading-log/manifest.json';
import type { ToolManifest } from '../shared/contracts';

export const catalog: ToolManifest[] = [readingLog];

export function requireTool(id: string): ToolManifest {
  const tool = catalog.find(item => item.id === id);
  if (!tool) throw new Error('工具未安装。');
  return tool;
}
