import { identifier } from '../development/sessions';
import { readText, writeText } from '../workspace/paths';

export interface VersionEntry { id: string; checksum: string }
export interface VersionHistory { schemaVersion: 1; projectId: string; head: string | null; entries: VersionEntry[] }
export function validateHistory(input: unknown, projectId: string): VersionHistory {
  const value = input as VersionHistory;
  if (!value || value.schemaVersion !== 1 || value.projectId !== projectId || !Array.isArray(value.entries)
      || value.entries.length > 100 || new Set(value.entries.map(entry => entry?.id)).size !== value.entries.length) throw new Error('版本历史记录无效。');
  for (const entry of value.entries) {
    identifier(entry.id);
    if (typeof entry.checksum !== 'string' || !/^[a-f0-9]{64}$/.test(entry.checksum)) throw new Error('版本校验记录无效。');
  }
  if (value.head !== null && !value.entries.some(entry => entry.id === value.head)) throw new Error('当前版本不属于版本历史。');
  return value;
}
export async function readHistory(root: string, projectId: string): Promise<VersionHistory> {
  try { return validateHistory(JSON.parse(await readText(root, 'history.json')), projectId); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return { schemaVersion: 1, projectId, head: null, entries: [] };
  }
}
export async function writeHistory(root: string, history: VersionHistory): Promise<void> {
  validateHistory(history, history.projectId);
  await writeText(root, 'history.json', JSON.stringify(history));
}
