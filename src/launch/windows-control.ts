import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, lstat, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { LaunchError } from './protocol.js';

const run = promisify(execFile);
const pipePattern = /^\\\\\.\\pipe\\DreamEdge-[a-f0-9]{64}$/;
/** A random pipe name is discovered only through an owner/SYSTEM-readable directory. */
export async function secureWindowsDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new LaunchError('UNSAFE_SOCKET', '本地控制目录无效。');
  const { stdout } = await run('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { windowsHide: true });
  const sid = stdout.match(/S-1-\d+(?:-\d+)+/)?.[0];
  if (!sid) throw new LaunchError('UNSAFE_SOCKET', '无法确认本机用户。');
  await run('icacls.exe', [directory, '/reset'], { windowsHide: true });
  await run('icacls.exe', [directory, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F'], { windowsHide: true });
}
export async function readWindowsPipe(directory: string): Promise<string> {
  const path = join(directory, 'control-pipe');
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256) throw new LaunchError('UNSAFE_SOCKET', '本地控制入口无效。');
  const pipe = await readFile(path, 'utf8');
  if (!pipePattern.test(pipe)) throw new LaunchError('UNSAFE_SOCKET', '本地控制入口无效。');
  return pipe;
}
export function newWindowsPipe(): string { return '\\\\.\\pipe\\DreamEdge-' + randomBytes(32).toString('hex'); }
export async function saveWindowsPipe(directory: string, pipe: string): Promise<void> {
  if (!pipePattern.test(pipe)) throw new LaunchError('UNSAFE_SOCKET', '本地控制入口无效。');
  const path = join(directory, 'control-pipe');
  try { const stat = await lstat(path); if (!stat.isFile() || stat.isSymbolicLink()) throw new LaunchError('UNSAFE_SOCKET', '本地控制入口无效。'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const temporary = join(directory, 'pipe-' + randomBytes(16).toString('hex'));
  try { await writeFile(temporary, pipe, { mode: 0o600, flag: 'wx' }); await rename(temporary, path); }
  finally { await rm(temporary, { force: true }); }
}
