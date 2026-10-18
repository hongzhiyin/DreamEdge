import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { rgPath } from '@vscode/ripgrep';
import { FileScopeError } from './scope-types.js';
import type { ReadSnapshot } from './read-snapshot.js';
import type { ReadToolName } from './read-limits.js';
import type { JsonObject } from '@earendil-works/pi-ai';
import type { ToolResult } from '../tools/types.js';
import { cleanToolResult } from '../tools/result.js';

export async function runReadWorker(snapshot: ReadSnapshot, name: ReadToolName, args: JsonObject, signal: AbortSignal): Promise<ToolResult> {
  if (process.platform === 'win32') throw new FileScopeError('FILE_IO_FAILED', '文件搜索尚未验证 Windows 进程隔离。');
  const binary = rgPath.replace('/app.asar/', '/app.asar.unpacked/');
  const modulePath = fileURLToPath(import.meta.url); const archiveIndex = modulePath.indexOf('/app.asar/');
  if (archiveIndex >= 0 && !binary.startsWith(`${modulePath.slice(0, archiveIndex)}/app.asar.unpacked/`)) {
    throw new FileScopeError('FILE_IO_FAILED', '应用包缺少自身的搜索二进制。');
  }
  await access(binary);
  const agent = join(snapshot.directory, 'pi'); const bin = join(agent, 'bin'); await mkdir(bin, { recursive: true, mode: 0o700 });
  const quote = (v: string) => `'${v.replace(/'/g, "'\\''")}'`;
  await writeFile(join(bin, 'rg'), `#!/bin/sh\nexec ${quote(binary)} --no-config --no-ignore-parent --no-ignore-global --no-require-git "$@"\n`, { mode: 0o700 });
  signal.throwIfAborted();
  const child = spawn(process.execPath, [fileURLToPath(new URL('./pi-read-worker.js', import.meta.url))], {
    cwd: snapshot.directory, detached: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { PATH: bin, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: '1', DREAMEDGE_RG_BINARY: binary, ELECTRON_RUN_AS_NODE: '1' },
  });
  const chunks: Buffer[] = []; let outputBytes = 0; let overflow = false; let launchFailed = false;
  const kill = () => { if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } } };
  const abort = () => kill(); signal.addEventListener('abort', abort, { once: true });
  child.stdin.on('error', () => {}); child.stderr.resume();
  child.stdout.on('data', chunk => { outputBytes += chunk.length; if (outputBytes <= 8 * 1024 * 1024) chunks.push(chunk); if (outputBytes > 8 * 1024 * 1024) { overflow = true; kill(); } });
  child.stdin.end(JSON.stringify({ name, args, root: snapshot.root, target: snapshot.target }));
  try {
    const code = await new Promise<number | null>(resolve => { child.once('error', () => { launchFailed = true; resolve(null); }); child.once('close', resolve); });
    signal.throwIfAborted();
    if (code !== 0 || overflow || launchFailed) throw new FileScopeError('FILE_IO_FAILED', '读取或搜索进程失败，未返回不完整结果。');
    const reply = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { ok: boolean; result: ToolResult };
    if (!reply.ok) throw new FileScopeError('FILE_IO_FAILED', 'Pi 文件工具返回失败。'); return cleanToolResult(reply.result);
  } finally { signal.removeEventListener('abort', abort); kill(); }
}
