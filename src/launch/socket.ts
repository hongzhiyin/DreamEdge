import { createServer, createConnection, type Socket } from 'node:net';
import { chmod, lstat, mkdir, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { LaunchError } from './protocol.js';
import { secureWindowsDirectory, readWindowsPipe, newWindowsPipe, saveWindowsPipe } from './windows-control.js';

export function controlDirectory(data: string): string {
  if (process.platform === 'win32') return join(resolve(data), 'launch-control');
  return join('/tmp', `ai-host-${process.getuid?.() ?? 'user'}-${createHash('sha256').update(resolve(data)).digest('hex').slice(0, 24)}`);
}
async function safeDirectory(directory: string) {
  if (process.platform === 'win32') { await secureWindowsDirectory(directory); return; }
  await mkdir(directory, { mode: 0o700, recursive: true });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) {
    throw new LaunchError('UNSAFE_SOCKET', '本地控制目录权限无效。');
  }
}
function readLine(socket: Socket, receive: (value: unknown) => void) {
  let input = '', bytes = 0, done = false;
  socket.setEncoding('utf8'); socket.setTimeout(120_000, () => socket.destroy());
  socket.on('data', chunk => {
    if (done) return;
    bytes += Buffer.byteLength(chunk); if (bytes > 64 * 1024) { socket.destroy(); return; }
    input += chunk; const end = input.indexOf('\n'); if (end < 0) return;
    done = true;
    try { receive(JSON.parse(input.slice(0, end))); } catch { socket.destroy(); }
  });
}
export async function callControl(directory: string, request: unknown): Promise<unknown> {
  if (process.platform !== 'win32') await safeDirectory(directory);
  else { const stat = await lstat(directory); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new LaunchError('UNSAFE_SOCKET', '本地控制目录无效。'); }
  const endpoint = process.platform === 'win32' ? await readWindowsPipe(directory) : join(directory, 'control.sock');
  return new Promise((accept, reject) => {
    const socket = createConnection(endpoint); let complete = false;
    socket.on('connect', () => socket.write(JSON.stringify(request) + '\n'));
    socket.on('error', reject);
    socket.on('close', () => { if (!complete) reject(new LaunchError('DISCONNECTED', '后台连接已中断。')); });
    readLine(socket, value => { complete = true; socket.end(); accept(value); });
  });
}
export async function startControl(directory: string, handler: (value: unknown) => Promise<unknown>) {
  await safeDirectory(directory);
  const windows = process.platform === 'win32';
  const path = windows ? newWindowsPipe() : join(directory, 'control.sock');
  // Only the Electron single-instance owner may remove a stale socket.
  if (!windows) try { const stat = await lstat(path); if (!stat.isSocket() || stat.uid !== process.getuid?.()) throw new Error('Unsafe socket'); await unlink(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const sockets = new Set<Socket>();
  const server = createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
    readLine(socket, value => { void Promise.resolve().then(() => handler(value)).then(data => socket.end(JSON.stringify({ ok: true, data }) + '\n'), error => {
      socket.end(JSON.stringify({ ok: false, error: { code: error instanceof LaunchError ? error.code : 'LAUNCH_FAILED',
        message: error instanceof LaunchError ? error.message : '会话启动失败。' } }) + '\n');
    }); });
  });
  await new Promise<void>((accept, reject) => { server.once('error', reject); server.listen(path, () => { server.off('error', reject); accept(); }); });
  try { if (windows) await saveWindowsPipe(directory, path); else await chmod(path, 0o600); }
  catch (error) { for (const socket of sockets) socket.destroy(); server.close(); throw error; }
  return { close: async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(accept => server.close(() => accept()));
  } };
}
