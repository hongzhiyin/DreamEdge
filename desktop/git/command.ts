import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpath } from 'node:fs/promises';

const execute = promisify(execFile);
export const MANAGED = ['src', '.dreamedge/project.json', '.gitignore'];
export async function git(root: string, args: string[], signal?: AbortSignal): Promise<string> {
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (name.startsWith('GIT_') || name.startsWith('DREAMEDGE_AI_') || name === 'NODE_OPTIONS') delete env[name];
  env.GIT_TERMINAL_PROMPT = '0';
  const filters: string[] = [];
  if (['add', 'commit'].includes(args[0])) {
    const names = await git(root, ['config', '--null', '--name-only', '--get-regexp', '^filter\.']).catch(() => '');
    for (const name of names.split('\0').filter(Boolean)) if (/^filter\..+\.(clean|smudge|process|required)$/.test(name)) {
      filters.push('-c', name + (name.endsWith('.required') ? '=false' : '='));
    }
  }
  try {
    const { stdout } = await execute('git', ['--literal-pathspecs', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
      '-c', 'commit.gpgSign=false', '-c', 'core.quotePath=false', ...filters, '-C', root, ...args], { env, signal, timeout: 30000, maxBuffer: 8 * 1024 * 1024, encoding: 'buffer' });
    return new TextDecoder('utf-8', { fatal: true }).decode(stdout);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('此设备未安装 Git，请安装 Git 后重新打开工程。');
    if (signal?.aborted) throw signal.reason;
    throw new Error('Git 操作失败，请检查工程仓库、文件锁或 Git 身份设置。');
  }
}
export async function assertRepository(root: string): Promise<void> {
  const top = (await git(root, ['rev-parse', '--show-toplevel'])).trim();
  if (await realpath(top) !== await realpath(root)) throw new Error('Git 仓库必须位于当前工程目录，不能使用上级仓库。');
}
export function commitId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{40,64}$/.test(value)) throw new Error('Git 提交身份无效。');
  return value;
}
