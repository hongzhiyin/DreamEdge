import { lstat, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { DEFINITION_FILE } from '../workspace/definition';
import { directory, ensureDirectory, hash, readText, writeText } from '../workspace/paths';
import { equalHashes } from '../workspace/source-tree';
import { readHistory, writeHistory } from './history';
import { retireTransaction, TRANSACTION, treeOrNull, validateJournal } from './journal';

export async function recoverTransaction(root: string, dataDirectory: string): Promise<void> {
  const transaction = join(root, TRANSACTION);
  try { await lstat(transaction); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  await directory(transaction);
  const journal = validateJournal(JSON.parse(await readText(transaction, 'journal.json')), root, await directory(dataDirectory));
  if (journal.ownerPid !== process.pid) {
    try { process.kill(journal.ownerPid, 0); throw new Error('该工程仍有另一个进程执行源码保存。'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
  }
  const projectId = journal.beforeHistory.projectId;
  const versions = await ensureDirectory(dataDirectory, `workspaces/${projectId}/versions`);
  const history = await readHistory(versions, projectId);
  const knownHistory = [journal.beforeHistory, journal.afterHistory].some(value => JSON.stringify(value) === JSON.stringify(history));
  const metadata = await readText(root, DEFINITION_FILE);
  if (!knownHistory || ![journal.beforeDefinition, journal.afterDefinition].some(value => hash(value) === hash(metadata))) {
    throw new Error('保存中断后工程描述或历史被外部修改；文件已保留，请核对事务目录。');
  }
  const current = await treeOrNull(join(root, 'src'));
  const previous = await treeOrNull(join(transaction, 'previous'));
  if (previous && !equalHashes(previous.hashes, journal.beforeHashes)) throw new Error('保存备份已被修改；文件已保留。');
  if (current && ![journal.beforeHashes, journal.afterHashes].some(hashes => equalHashes(current.hashes, hashes))) {
    throw new Error('中断后源码被外部修改；不自动覆盖，事务备份已保留。');
  }
  if (journal.phase === 'committed') {
    if (!current || !equalHashes(current.hashes, journal.afterHashes)) throw new Error('已提交版本的源码无法核对；文件已保留。');
    await writeText(root, DEFINITION_FILE, journal.afterDefinition);
    await writeHistory(versions, journal.afterHistory);
  } else {
    if (previous && (!current || !equalHashes(current.hashes, journal.beforeHashes))) {
      if (current) {
        const discard = join(transaction, 'discard');
        try { await lstat(discard); throw new Error('事务暂存目录已存在，请核对后恢复。'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        await rename(join(root, 'src'), discard);
      }
      await rename(join(transaction, 'previous'), join(root, 'src'));
    } else if (!current || !equalHashes(current.hashes, journal.beforeHashes)) {
      throw new Error('无法核对保存前的源码；事务备份已保留。');
    }
    await writeText(root, DEFINITION_FILE, journal.beforeDefinition);
    await writeHistory(versions, journal.beforeHistory);
  }
  await retireTransaction(root, journal.operationId);
}
