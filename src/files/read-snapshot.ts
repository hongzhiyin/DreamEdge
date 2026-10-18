import { mkdtemp, mkdir, writeFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, basename } from 'node:path';
import type { FileScopeService } from './scope-service.js';
import type { FileAccessBinding, FileObservation } from './scope-types.js';
import { FileScopeError } from './scope-types.js';
import { readScopedFile } from './scoped-read.js';
import { listScopedDirectory } from './scoped-directory.js';
import type { ReadLimits, ReadToolName } from './read-limits.js';

export interface ReadSnapshot {
  directory: string; root: string; target: string; binding: FileAccessBinding;
  observations: { binding: FileAccessBinding; observation: FileObservation }[];
  entries: number; bytes: number; skipped: number;
  dispose(): Promise<void>;
}
export async function createReadSnapshot(scopes: FileScopeService, binding: FileAccessBinding,
  name: ReadToolName, signal: AbortSignal, limits: ReadLimits, cacheRoot = tmpdir()): Promise<ReadSnapshot> {
  signal.throwIfAborted(); const directory = await mkdtemp(join(cacheRoot, 'dreamedge-file-snapshot-'));
  const root = join(directory, 'input');
  const snapshot: ReadSnapshot = { directory, root, target: root,
    binding, observations: [], entries: 0, bytes: 0, skipped: 0,
    dispose: () => rm(directory, { recursive: true, force: true }) };
  try {
    await chmod(directory, 0o700); await mkdir(root, { mode: 0o700 });
    const first = await scopes.verify(binding); snapshot.target = first.stat?.isDirectory() ? root : join(root, basename(binding.path));
    const copy = async (file: FileAccessBinding, destination: string) => {
      const remaining = Math.max(1, limits.totalBytes - snapshot.bytes);
      const data = await readScopedFile(scopes, file, signal, Math.min(limits.fileBytes, remaining), false);
      snapshot.bytes += data.data.length;
      if (snapshot.bytes > limits.totalBytes) throw new FileScopeError('FILE_TOO_LARGE', '搜索输入总字节超过上限。');
      data.observation.complete = name === 'read';
      snapshot.observations.push({ binding: file, observation: data.observation });
      signal.throwIfAborted(); await writeFile(destination, data.data, { mode: 0o600, flag: 'wx' });
    };
    const walk = async (dir: FileAccessBinding, destination: string, depth: number) => {
      if (depth > limits.depth) throw new FileScopeError('FILE_TOO_LARGE', '目录深度超过扫描上限。');
      for (const path of await listScopedDirectory(scopes, dir, signal, limits.entries)) {
        if (++snapshot.entries > limits.entries) throw new FileScopeError('FILE_TOO_LARGE', '目录项目数超过扫描上限。');
        if (/[\x00-\x1f\x7f]/.test(basename(path))) { snapshot.skipped++; continue; }
        let child: FileAccessBinding;
        try { child = await scopes.bind(binding, binding.grantId, path, 'read'); }
        catch (error) {
          if (error instanceof FileScopeError && error.code === 'FILE_SCOPE_DENIED') { snapshot.skipped++; continue; }
          throw error;
        }
        const stat = (await scopes.verify(child)).stat; const out = join(destination, basename(path));
        if (stat?.isDirectory()) {
          await mkdir(out, { mode: 0o700 });
          if (name !== 'ls') await walk(child, out, depth + 1);
        } else if (stat?.isFile()) {
          if (name === 'grep' || (name === 'find' && ['.gitignore', '.ignore', '.rgignore'].includes(basename(path)))) await copy(child, out);
          else await writeFile(out, '', { mode: 0o600, flag: 'wx' });
        }
      }
      await scopes.verify(dir);
    };
    if (name === 'read') { if (!first.stat?.isFile()) throw new FileScopeError('FILE_SCOPE_DENIED', '读取需要普通文件。'); await copy(binding, snapshot.target); }
    else if (first.stat?.isDirectory()) await walk(binding, root, 0);
    else if (name === 'grep' && first.stat?.isFile()) await copy(binding, snapshot.target);
    else throw new FileScopeError('FILE_SCOPE_DENIED', '此工具需要目录。');
    signal.throwIfAborted(); await scopes.verify(binding); return snapshot;
  } catch (error) { await snapshot.dispose(); throw error; }
}
