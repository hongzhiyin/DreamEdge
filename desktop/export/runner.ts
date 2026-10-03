import { spawn } from 'node:child_process';
import type { ExportEngine } from './types';

export function workerExportEngine(worker: string, template: string, electronVersion: string): ExportEngine {
  return (input, signal, progress) => new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const env: NodeJS.ProcessEnv = { ELECTRON_RUN_AS_NODE: '1',
      CSC_IDENTITY_AUTO_DISCOVERY: 'false', ELECTRON_BUILDER_CACHE: input.root + '/cache' };
    for (const key of ['PATH', 'SYSTEMROOT', 'WINDIR', 'TMP', 'TEMP', 'TMPDIR']) if (process.env[key]) env[key] = process.env[key];
    const child = spawn(process.execPath, [worker], { cwd: input.root, env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    let output = ''; let total = 0; let failure = ''; const notices: Promise<void>[] = [];
    const abort = () => { try { if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch {} };
    signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
    child.stdout.on('data', chunk => { total += chunk.length; if (total > 1024 * 1024) { failure = '打包日志超过限制。'; abort(); return; }
      output += String(chunk); notices.push(progress(String(chunk).replace(/\u001b\[[0-9;]*m/g, '').trim().slice(0, 1800)).catch(() => {})); });
    child.stderr.on('data', chunk => { failure = (failure + String(chunk)).slice(-1800); });
    child.stdin.on('error', () => {}); child.on('error', () => reject(new Error('无法启动 App 打包进程。')));
    child.on('close', code => { signal.removeEventListener('abort', abort); void Promise.all(notices).then(() => {
      if (signal.aborted) reject(signal.reason); else if (code !== 0 || !output.includes('DREAMEDGE_EXPORT_OK')) reject(new Error(failure || 'App 打包失败，请检查日志后重试。')); else resolve();
    }); });
    child.stdin.end(JSON.stringify({ ...input, template, electronVersion }));
  });
}
