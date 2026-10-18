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

export async function validateWindowsDirectory(directory: string): Promise<void> {
  const script = `$ErrorActionPreference='Stop';
$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value;
$owners=@($sid,'S-1-5-18','S-1-5-32-544');$readers=@($sid,'S-1-5-18');$safe=$true;
foreach($path in @($env:DREAMEDGE_CONTROL_DIRECTORY,([System.IO.Path]::Combine($env:DREAMEDGE_CONTROL_DIRECTORY,'control-pipe')))){
 $acl=if([System.IO.Directory]::Exists($path)){[System.IO.Directory]::GetAccessControl($path)}else{[System.IO.File]::GetAccessControl($path)};
 if($owners -notcontains $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value){$safe=$false};
 if($path -eq $env:DREAMEDGE_CONTROL_DIRECTORY -and !$acl.AreAccessRulesProtected){$safe=$false};
 foreach($rule in $acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])){
  if($rule.AccessControlType -eq 'Allow' -and $readers -notcontains $rule.IdentityReference.Value){$safe=$false}
 }
};if($safe){[Console]::Write('safe')}else{[Console]::Write('unsafe')}`;
  const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true, env: { ...process.env, DREAMEDGE_CONTROL_DIRECTORY: directory },
  });
  if (stdout.trim() !== 'safe') throw new LaunchError('UNSAFE_SOCKET', '本地控制入口并非仅当前用户可访问。');
}
