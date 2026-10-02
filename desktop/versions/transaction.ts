import { mkdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import type { WorkspaceProject } from '../../shared/contracts';
import { DEFINITION_FILE } from '../workspace/definition';
import { ensureDirectory, readText, writeText } from '../workspace/paths';
import { equalHashes, readSourceTree, writeSourceTree } from '../workspace/source-tree';
import { readHistory, writeHistory } from './history';
import { retireTransaction, type SaveJournal, TRANSACTION } from './journal';
import { recoverTransaction } from './recovery';

export type SavePhase = 'prepared' | 'source-backed-up' | 'source-installed' | 'metadata-installed' | 'history-installed' | 'committed';
export type SaveHook = (phase: SavePhase) => Promise<void>;
export async function commitTransaction(project: WorkspaceProject, dataDirectory: string, journal: SaveJournal,
  files: Record<string, string>, signal: AbortSignal, hook: SaveHook = async () => {}): Promise<void> {
  const transaction = join(project.rootDirectory, TRANSACTION);
  await mkdir(transaction); // An active or unresolved transaction is never overwritten.
  let committed = false;
  let swapped = false;
  try {
    await writeText(transaction, 'journal.json', JSON.stringify(journal));
    await writeSourceTree(await ensureDirectory(transaction, 'next'), files, signal);
    await hook('prepared'); signal.throwIfAborted();
    const current = await readSourceTree(project.sourceDirectory);
    if (!equalHashes(current.hashes, journal.beforeHashes)
        || await readText(project.rootDirectory, DEFINITION_FILE) !== journal.beforeDefinition
        || JSON.stringify(await readHistory(project.versionsDirectory, project.definition.id)) !== JSON.stringify(journal.beforeHistory)) {
      throw new Error('工程在保存准备期间发生变化，拒绝覆盖。');
    }
    // After this point cancellation cannot interrupt the swap; finish or roll back it.
    await rename(project.sourceDirectory, join(transaction, 'previous')); swapped = true; await hook('source-backed-up');
    await rename(join(transaction, 'next'), project.sourceDirectory); await hook('source-installed');
    await writeText(project.rootDirectory, DEFINITION_FILE, journal.afterDefinition); await hook('metadata-installed');
    await writeHistory(project.versionsDirectory, journal.afterHistory); await hook('history-installed');
    await writeText(transaction, 'journal.json', JSON.stringify({ ...journal, phase: 'committed' }));
    committed = true; await hook('committed');
  } catch (error) {
    if (!committed) {
      if (swapped) await recoverTransaction(project.rootDirectory, dataDirectory);
      else await retireTransaction(project.rootDirectory, journal.operationId);
      throw error;
    }
  }
  // Committed recovery uses the new tree if cleanup is interrupted.
  await retireTransaction(project.rootDirectory, journal.operationId);
}
