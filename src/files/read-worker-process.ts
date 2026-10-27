import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { join } from 'node:path';

/** Pi 1.1.0's internal killProcessTree is not exported and does not await cleanup. */
export async function stopReadProcessTree(child: ChildProcess): Promise<void> {
  if (!child.pid) return;
  if (process.platform !== 'win32') {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
    return;
  }
  // Use the same native tree terminator as Pi, awaiting it before snapshot removal.
  await new Promise<void>(resolve => {
    const killer = spawn(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'),
      ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore', windowsHide: true });
    killer.once('error', () => { child.kill('SIGKILL'); resolve(); });
    killer.once('close', code => { if (code !== 0) child.kill('SIGKILL'); resolve(); });
  });
}
