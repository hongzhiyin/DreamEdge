import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpath } from 'node:fs/promises';

const execute = promisify(execFile);
export async function git(root: string, args: string[], signal?: AbortSignal): Promise<string> {
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (name.startsWith('GIT_') || name.startsWith('DREAMEDGE_AI_') || name === 'NODE_OPTIONS') delete env[name];
  env.GIT_TERMINAL_PROMPT = '0';
  const filters: string[] = [];
  if (['add', 'commit', 'restore', 'merge'].includes(args[0])) {
    const names = await git(root, ['config', '--null', '--name-only', '--get-regexp', '^filter\.']).catch(() => '');
    for (const name of names.split('\0').filter(Boolean)) if (/^filter\..+\.(clean|smudge|process|required)$/.test(name)) {
      filters.push('-c', name + (name.endsWith('.required') ? '=false' : '='));
    }
  }
  try {
    const { stdout } = await execute('git', [...(args[0] === 'check-ignore' ? [] : ['--literal-pathspecs']), '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
      '-c', 'commit.gpgSign=false', '-c', 'core.quotePath=false', ...filters, '-C', root, ...args], { env, signal,
        timeout: ['fetch', 'push', 'ls-remote'].includes(args[0]) ? 120000 : 30000, maxBuffer: 8 * 1024 * 1024, encoding: 'buffer' });
    return new TextDecoder('utf-8', { fatal: true }).decode(stdout);
  } catch (error) {
    if (args[0] === 'check-ignore' && (error as { code?: unknown }).code === 1) return '';
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('此设备未安装 Git，请安装 Git 后重新打开工程。');
    if (signal?.aborted) throw signal.reason;
    if (['fetch', 'push', 'ls-remote'].includes(args[0])) throw new Error('远程 Git 操作失败，请检查网络、仓库权限和本机 Git/SSH 凭据；推送被拒绝时请先拉取。');
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
