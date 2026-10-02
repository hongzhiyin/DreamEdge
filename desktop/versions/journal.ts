import { lstat, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { identifier } from '../development/sessions';
import { validateDefinition } from '../workspace/definition';
import { readSourceTree, validHashes } from '../workspace/source-tree';
import { validateHistory, type VersionHistory } from './history';

export const TRANSACTION = '.dreamedge/transaction';
export async function retireTransaction(root: string, operationId: string): Promise<void> {
  const garbage = join(root, `.dreamedge/.finished-${identifier(operationId)}`);
  await rename(join(root, TRANSACTION), garbage);
  // Cleanup can be interrupted without leaving a half-deleted active journal.
  await rm(garbage, { recursive: true, force: true }).catch(() => {});
}
export interface SaveJournal {
  schemaVersion: 1; operationId: string; ownerPid: number; root: string; profile: string;
  phase: 'prepared' | 'committed';
  beforeDefinition: string; afterDefinition: string;
  beforeHashes: Record<string, string>; afterHashes: Record<string, string>;
  beforeHistory: VersionHistory; afterHistory: VersionHistory;
}
export function validateJournal(input: unknown, root: string, profile: string): SaveJournal {
  const journal = input as SaveJournal;
  if (!journal || journal.schemaVersion !== 1 || journal.root !== root || journal.profile !== profile
      || !Number.isSafeInteger(journal.ownerPid) || journal.ownerPid <= 0 || !['prepared', 'committed'].includes(journal.phase)
      || typeof journal.beforeDefinition !== 'string' || typeof journal.afterDefinition !== 'string'
      || !validHashes(journal.beforeHashes) || !validHashes(journal.afterHashes)) throw new Error('源码保存事务记录无效；现有文件已保留。');
  identifier(journal.operationId);
  const before = validateDefinition(JSON.parse(journal.beforeDefinition));
  const after = validateDefinition(JSON.parse(journal.afterDefinition));
  if (before.id !== after.id || before.appId !== after.appId) throw new Error('保存事务工程身份无效。');
  validateHistory(journal.beforeHistory, before.id); validateHistory(journal.afterHistory, before.id);
  return journal;
}
export async function treeOrNull(root: string) {
  try { return await readSourceTree(root); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    try { await lstat(root); } catch (missing) { if ((missing as NodeJS.ErrnoException).code === 'ENOENT') return null; throw missing; }
    throw error;
  }
}
