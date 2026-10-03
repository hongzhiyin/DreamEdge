import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { readText, writeText } from '../workspace/paths';
import { assertRepository, git } from './command';

export async function initializeGit(root: string): Promise<void> {
  let exists = false;
  try { const stat = await lstat(join(root, '.git')); if (stat.isSymbolicLink()) throw new Error('工程 Git 目录不能是符号链接。'); exists = true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (!exists) await git(root, ['init', '--initial-branch=main']);
  await assertRepository(root);
  let ignore = '';
  try { ignore = await readText(root, '.gitignore'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const rules = ['/.dreamedge/model.json', '/.dreamedge/transaction/', '/.dreamedge/.finished-*/', ...(!exists ? ['.DS_Store'] : [])];
  const missing = rules.filter(rule => !ignore.split(/\r?\n/).includes(rule));
  if (missing.length) await writeText(root, '.gitignore', ignore + (ignore && !ignore.endsWith('\n') ? '\n' : '') + missing.join('\n') + '\n');
  if (exists) return;
  for (const [name, fallback] of [['user.name', 'DreamEdge'], ['user.email', 'dreamedge@local']]) {
    let value = '';
    try { value = (await git(root, ['config', '--get', name])).trim(); } catch {}
    if (!value) await git(root, ['config', '--local', name, fallback]);
  }
  await git(root, ['add', '--all', '--', '.']);
  await git(root, ['commit', '-m', 'Initialize DreamEdge project']);
}
export async function gitStatus(root: string) {
  await assertRepository(root);
  let head: string | null = null;
  try { head = (await git(root, ['rev-parse', '--verify', 'HEAD'])).trim(); } catch {}
  let branch = 'HEAD';
  try { branch = (await git(root, ['symbolic-ref', '--short', 'HEAD'])).trim(); } catch {}
  const porcelain = await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const entries = porcelain.split('\0').filter(Boolean);
  const changed: string[] = [];
  for (let index = 0; index < entries.length; index++) {
    changed.push(entries[index].slice(3)); if (/[RC]/.test(entries[index].slice(0, 2))) index++;
  }
  return { head, branch, changed, porcelain };
}
export async function commitGit(root: string, message: string, signal?: AbortSignal): Promise<string | null> {
  const status = await gitStatus(root); if (!status.changed.length) return status.head;
  await git(root, ['add', '--all', '--', '.'], signal);
  await git(root, ['commit', '-m', message], signal);
  return (await git(root, ['rev-parse', 'HEAD'])).trim();
}
