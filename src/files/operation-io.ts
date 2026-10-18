import { constants } from 'node:fs';
import { copyFile, cp, lstat, mkdir, rmdir, unlink } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import type { FileScopeService } from './scope-service.js';
import type { FileAccessBinding } from './scope-types.js';
import type { TreeManifest } from './operation-types.js';
import { fileIdentity, sameIdentity } from './scope-paths.js';
import { sameTreeEntry, treeManifest } from './tree-manifest.js';
import { canonicalJson } from '../tools/json.js';
import { NoFileEffectError } from './mutation-types.js';

export async function checkTree(scopes: FileScopeService, binding: FileAccessBinding, expected: TreeManifest, signal: AbortSignal) {
  if ((await treeManifest(scopes, binding, signal)).digest !== expected.digest) throw new NoFileEffectError('文件或目录内容已变化，请重新准备计划。');
}
/** Remove only the exact enumerated files; rmdir refuses newly introduced directory contents. */
export async function removeTree(scopes: FileScopeService, binding: FileAccessBinding, tree: TreeManifest, signal: AbortSignal) {
  for (const entry of [...tree.entries].reverse()) {
    signal.throwIfAborted();
    const next = await scopes.bindWrite(binding, join(binding.path, entry.relative));
    const target = await scopes.verify(next);
    if (!target.stat || !sameIdentity(entry, fileIdentity(target.stat))
      || (entry.kind === 'file' && !sameTreeEntry(entry, target.stat))) throw new NoFileEffectError('删除目标已变化。');
    signal.throwIfAborted();
    if (entry.kind === 'file') await unlink(next.path); else await rmdir(next.path);
  }
}
/** Standard Node copy primitives provide exclusive file creation; DSH has no binary/tree copy API. */
export async function copyTree(scopes: FileScopeService, source: FileAccessBinding, destination: FileAccessBinding,
  expected: TreeManifest, signal: AbortSignal) {
  if (expected.entries[0]!.kind === 'file') {
    await copyFile(source.path, destination.path, constants.COPYFILE_EXCL);
  } else {
    await mkdir(destination.path, { mode: 0o700 });
    const root = fileIdentity(await lstat(destination.path, { bigint: true }));
    for (const child of expected.entries.filter(entry => entry.relative && !entry.relative.includes('/'))) {
      await cp(join(source.path, child.relative), join(destination.path, child.relative), { recursive: true, force: false, errorOnExist: true, mode: constants.COPYFILE_EXCL,
      dereference: false, filter: async path => {
        signal.throwIfAborted();
        const key = relative(source.path, path).split(sep).join('/'); const entry = expected.entries.find(e => e.relative === key);
        const binding = await scopes.bindRead(source, path); const current = await scopes.verify(binding);
        if (!entry || !current.stat || !sameTreeEntry(entry, current.stat)
          || !sameIdentity(root, fileIdentity(await lstat(destination.path, { bigint: true })))) throw new NoFileEffectError('复制对象已变化。');
        return true;
      } });
    }
  }
  await checkTree(scopes, source, expected, signal);
  const copied = await treeManifest(scopes, destination, signal);
  const content = (tree: TreeManifest) => tree.entries.map(e => ({ relative: e.relative, kind: e.kind,
    ...(e.kind === 'file' ? { size: e.size, hash: e.hash } : {}) }));
  if (canonicalJson(content(expected)) !== canonicalJson(content(copied))) throw new NoFileEffectError('复制结果与源清单不一致。');
}
