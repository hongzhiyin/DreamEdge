import { randomUUID, createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import type { BigIntStats } from 'node:fs';
import type { FileScopeService } from './scope-service.js';
import { fileIdentity, sameIdentity } from './scope-paths.js';
import { FileScopeError } from './scope-types.js';
import type { FileAccessBinding, FileObservation } from './scope-types.js';

const unchanged = (a: BigIntStats, b: BigIntStats) => sameIdentity(fileIdentity(a), fileIdentity(b))
  && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
/** Read through the verified descriptor, never reopen the path after validation. No mutation API. */
export async function readScopedFile(scopes: FileScopeService, binding: FileAccessBinding,
  signal: AbortSignal, maxBytes = 4 * 1024 * 1024, record = true): Promise<{ data: Buffer; observation: FileObservation }> {
  if (binding.mode !== 'read' || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 64 * 1024 * 1024) {
    throw new FileScopeError('FILE_SCOPE_INVALID', '文件读取参数无效。');
  }
  signal.throwIfAborted(); const target = await scopes.verify(binding); signal.throwIfAborted();
  if (!target.stat?.isFile() || target.stat.nlink !== 1n) throw new FileScopeError('FILE_SCOPE_DENIED', '只能读取授权的普通文件。');
  const handle = await open(binding.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat({ bigint: true }); signal.throwIfAborted();
    if (!unchanged(target.stat, before) || !before.isFile() || before.nlink !== 1n) changed();
    await scopes.verify(binding); signal.throwIfAborted();
    if (before.size > BigInt(maxBytes)) throw new FileScopeError('FILE_TOO_LARGE', '文件超过读取字节上限。');
    const chunks: Buffer[] = []; let position = 0;
    while (position <= maxBytes) {
      signal.throwIfAborted(); await scopes.verify(binding); signal.throwIfAborted();
      const buffer = Buffer.alloc(Math.min(64 * 1024, maxBytes + 1 - position));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (!bytesRead) break;
      position += bytesRead; if (position > maxBytes) throw new FileScopeError('FILE_TOO_LARGE', '文件超过读取字节上限。');
      chunks.push(buffer.subarray(0, bytesRead));
    }
    const after = await handle.stat({ bigint: true }); const final = await scopes.verify(binding); signal.throwIfAborted();
    if (!unchanged(before, after) || !final.stat || !unchanged(before, final.stat) || after.nlink !== 1n) changed();
    const data = Buffer.concat(chunks); if (BigInt(data.length) !== after.size) changed();
    const observation: FileObservation = { observationId: randomUUID(), grantId: binding.grantId, rootId: binding.rootId,
      policyVersion: binding.policyVersion, path: binding.path, destination: structuredClone(binding.destination),
      version: { ...fileIdentity(after), size: String(after.size), modifiedNs: String(after.mtimeNs),
        changedNs: String(after.ctimeNs), sha256: createHash('sha256').update(data).digest('hex') },
      observedAt: Date.now(), source: { sessionId: binding.sessionId, runId: binding.runId, turnId: binding.turnId,
        toolCallId: binding.toolCallId }, complete: true };
    if (record) scopes.recordObservation(binding, observation); return { data, observation };
  } catch (error) {
    if (error instanceof FileScopeError || signal.aborted) throw error;
    throw new FileScopeError('FILE_IO_FAILED', '无法完成受控文件读取。');
  } finally { await handle.close(); }
}
function changed(): never { throw new FileScopeError('FILE_CHANGED', '文件身份或版本已变化，请重新读取。'); }
