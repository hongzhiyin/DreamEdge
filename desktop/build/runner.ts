import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { BuildFailure, type BuildEngine, type BuildOutput } from './types';

export function workerEngine(workerPath: string): BuildEngine {
  return (input, signal) => new Promise<BuildOutput>((resolve, reject) => {
    signal.throwIfAborted();
    const env: NodeJS.ProcessEnv = { ELECTRON_RUN_AS_NODE: '1' };
    // Native executables cannot be spawned from ASAR; use only the framework's pinned binary.
    const require = createRequire(__filename);
    const fromEsbuild = createRequire(require.resolve('esbuild'));
    const binary = process.platform === 'win32' ? `@esbuild/win32-${process.arch}/esbuild.exe`
      : `@esbuild/${process.platform}-${process.arch}/bin/esbuild`;
    env.ESBUILD_BINARY_PATH = fromEsbuild.resolve(binary).replace(/\.asar([/\\])/, '.asar.unpacked$1');
    for (const key of ['PATH', 'SYSTEMROOT', 'WINDIR', 'TMP', 'TEMP', 'TMPDIR']) if (process.env[key]) env[key] = process.env[key];
    const child = spawn(process.execPath, [workerPath], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let overflow = false;
    const abort = () => child.kill('SIGKILL');
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 52 * 1024 * 1024) { overflow = true; abort(); } else chunks.push(chunk);
    });
    child.stderr.resume();
    child.stdin.on('error', () => {});
    child.on('error', () => reject(new BuildFailure([{ level: 'error', message: '无法启动框架构建进程。' }])));
    child.on('close', code => {
      signal.removeEventListener('abort', abort);
      if (signal.aborted) { reject(signal.reason); return; }
      if (code !== 0 || overflow) { reject(new BuildFailure([{ level: 'error', message: '构建进程异常退出或输出过大。' }])); return; }
      try {
        const response = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!response.ok) throw new BuildFailure(response.logs);
        resolve(response.result);
      } catch (error) { reject(error instanceof BuildFailure ? error : new BuildFailure([{ level: 'error', message: '构建进程返回了无效数据。' }])); }
    });
    child.stdin.end(JSON.stringify(input));
  });
}
