import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, lstat } from 'node:fs/promises';
import { relative, sep } from 'node:path';
import type { BigIntStats } from 'node:fs';
import type { FileScopeService } from './scope-service.js';
import type { FileAccessBinding } from './scope-types.js';
import type { TreeEntry, TreeManifest } from './operation-types.js';
import { listScopedDirectory } from './scoped-directory.js';
import { NoFileEffectError } from './mutation-types.js';
import { contentHash } from './mutation-digest.js';
import { canonicalJson } from '../tools/json.js';

const stamp = (s: BigIntStats) => ({ device: String(s.dev), inode: String(s.ino), size: String(s.size),
  modifiedNs: String(s.mtimeNs), changedNs: String(s.ctimeNs) });
export const sameTreeEntry = (a: TreeEntry, s: BigIntStats) => canonicalJson(stamp(s)) === canonicalJson({
  device: a.device, inode: a.inode, size: a.size, modifiedNs: a.modifiedNs, changedNs: a.changedNs });
const fail = (): never => { throw new NoFileEffectError('对象已变化、含受保护项目或超过完整检查上限。'); };
/** Complete bounded inventory; no silent skipping and no content is sent to the model. */
export async function treeManifest(scopes: FileScopeService, root: FileAccessBinding, signal: AbortSignal): Promise<TreeManifest> {
  const entries: TreeEntry[] = []; let bytes = 0;
  async function visit(binding: FileAccessBinding, depth: number): Promise<void> {
    signal.throwIfAborted(); if (depth > 32 || entries.length >= 1024) fail();
    const { stat } = await scopes.verify(binding); if (!stat || (!stat.isFile() && !stat.isDirectory())) fail();
    const entry: TreeEntry = { relative: relative(root.path, binding.path).split(sep).join('/'),
      kind: stat!.isFile() ? 'file' : 'directory', ...stamp(stat!) };
    entries.push(entry);
    if (stat!.isFile()) {
      bytes += Number(stat!.size); if (!Number.isSafeInteger(bytes) || bytes > 1024 * 1024 * 1024) fail();
      const file = await open(binding.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        if (!sameTreeEntry(entry, await file.stat({ bigint: true }))) fail();
        const hash = createHash('sha256'); const buffer = Buffer.alloc(1024 * 1024); let position = 0;
        while (position <= Number(stat!.size)) {
          signal.throwIfAborted(); const read = await file.read(buffer, 0, buffer.length, position);
          if (!read.bytesRead) break;
          position += read.bytesRead; if (position > Number(stat!.size)) fail(); hash.update(buffer.subarray(0, read.bytesRead));
        }
        if (position !== Number(stat!.size) || !sameTreeEntry(entry, await file.stat({ bigint: true }))) fail();
        entry.hash = hash.digest('hex');
      } finally { await file.close(); }
    } else {
      for (const child of await listScopedDirectory(scopes, binding, signal, 1024)) {
        const source = { sessionId: root.sessionId, runId: root.runId, turnId: root.turnId, toolCallId: root.toolCallId };
        // Inspect the raw child first: resolving a symlink would hide a protected or unapproved subtree.
        if ((await lstat(child)).isSymbolicLink()) fail();
        const next = binding.mode === 'write' ? await scopes.bindWrite(source, child) : await scopes.bindRead(source, child);
        await visit(next, depth + 1);
      }
    }
    const after = await scopes.verify(binding); if (!after.stat || !sameTreeEntry(entry, after.stat)) fail();
  }
  await visit(root, 0); signal.throwIfAborted();
  return { entries, bytes, digest: contentHash(canonicalJson(entries)) };
}
