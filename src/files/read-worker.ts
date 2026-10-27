import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile, access, copyFile } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { rgPath } from '@vscode/ripgrep';
import { FileScopeError } from './scope-types.js';
import type { ReadSnapshot } from './read-snapshot.js';
import type { ReadToolName } from './read-limits.js';
import type { JsonObject } from '@earendil-works/pi-ai';
import type { ToolResult } from '../tools/types.js';
import { cleanToolResult } from '../tools/result.js';
import { containsPath } from './scope-paths.js';
import { stopReadProcessTree } from './read-worker-process.js';

export async function runReadWorker(snapshot: ReadSnapshot, name: ReadToolName, args: JsonObject, signal: AbortSignal): Promise<ToolResult> {
  const windows = process.platform === 'win32';
  const binary = rgPath.replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2');
  const modulePath = fileURLToPath(import.meta.url); const archiveIndex = modulePath.indexOf(`${sep}app.asar${sep}`);
  if (archiveIndex >= 0 && !containsPath(join(modulePath.slice(0, archiveIndex), 'app.asar.unpacked'), binary)) {
    throw new FileScopeError('FILE_IO_FAILED', '应用包缺少自身的搜索二进制。');
  }
  await access(binary);
  const agent = join(snapshot.directory, 'pi'); const bin = join(agent, 'bin'); await mkdir(bin, { recursive: true, mode: 0o700 });
  const env: NodeJS.ProcessEnv = { PATH: bin, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: '1',
    DREAMEDGE_RG_BINARY: binary, ELECTRON_RUN_AS_NODE: '1' };
  if (windows) {
    // Pi 1.1.0 discovers bin/rg.exe, but its grep factory has no process/argv hook.
    // A private copy and fixed config retain Pi's implementation without a shell.
    await copyFile(binary, join(bin, 'rg.exe'));
    const config = join(agent, 'ripgrep.config');
    await writeFile(config, '--no-ignore-parent\n--no-ignore-global\n--no-require-git\n', { mode: 0o600 });
    env.RIPGREP_CONFIG_PATH = config;
    env.SystemRoot = process.env.SystemRoot ?? 'C:\\Windows';
  } else {
    const quote = (v: string) => `'${v.replace(/'/g, "'\\''")}'`;
    await writeFile(join(bin, 'rg'), `#!/bin/sh\nexec ${quote(binary)} --no-config --no-ignore-parent --no-ignore-global --no-require-git "$@"\n`, { mode: 0o700 });
  }
  signal.throwIfAborted();
  const child = spawn(process.execPath, [fileURLToPath(new URL('./pi-read-worker.js', import.meta.url))], {
    cwd: snapshot.directory, detached: !windows, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env,
  });
  const chunks: Buffer[] = []; let outputBytes = 0; let overflow = false; let launchFailed = false;
  let stopping: Promise<void> | undefined;
  const kill = () => {
    if (child.pid && !stopping) stopping = stopReadProcessTree(child);
  };
  const abort = () => kill(); signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) kill();
  child.stdin.on('error', () => {}); child.stderr.resume();
  child.stdout.on('data', chunk => { outputBytes += chunk.length; if (outputBytes <= 8 * 1024 * 1024) chunks.push(chunk); if (outputBytes > 8 * 1024 * 1024) { overflow = true; kill(); } });
  child.stdin.end(JSON.stringify({ name, args, root: snapshot.root, target: snapshot.target }));
  try {
    const code = await new Promise<number | null>(resolve => { child.once('error', () => { launchFailed = true; resolve(null); }); child.once('close', resolve); });
    signal.throwIfAborted();
    if (code !== 0 || overflow || launchFailed) throw new FileScopeError('FILE_IO_FAILED', '读取或搜索进程失败，未返回不完整结果。');
    const reply = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { ok: boolean; result: ToolResult };
    if (!reply.ok) throw new FileScopeError('FILE_IO_FAILED', 'Pi 文件工具返回失败。'); return cleanToolResult(reply.result);
  } finally {
    signal.removeEventListener('abort', abort);
    if (!windows || (child.exitCode === null && child.signalCode === null)) kill();
    await stopping;
  }
}
