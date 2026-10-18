import { lstat, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ToolExecutionContext, ToolResult } from '../tools/types.js';
import type { FileScopeService } from './scope-service.js';
import type { OperationHost, OperationPreview } from './operation-types.js';
import { fileIdentity, sameIdentity } from './scope-paths.js';
import { managedMutationQueue } from './mutation-queue.js';
import { NoFileEffectError } from './mutation-types.js';
import { copyTree, checkTree, removeTree } from './operation-io.js';
import { jsonCopy } from '../tools/json.js';
import { operationLabels } from './preview.js';

export async function commitOperation(scopes: FileScopeService, p: OperationPreview, ctx: ToolExecutionContext,
  host: OperationHost): Promise<ToolResult> {
  return managedMutationQueue(async () => {
    let started = false; let committed = false;
    const check = async () => {
      ctx.signal.throwIfAborted(); const permit = ctx.approval;
      if (!permit?.file || permit.file.planId !== p.planId || permit.file.planDigest !== p.planDigest
        || permit.file.policyVersion !== p.policyVersion || Date.now() >= permit.expiresAt) throw new NoFileEffectError('结构变更许可已失效。');
      for (const location of [{ binding: p.binding, parentIdentity: p.parentIdentity }, ...(p.destination ? [p.destination] : [])]) {
        await scopes.verify(location.binding);
        if (!sameIdentity(location.parentIdentity, fileIdentity(await lstat(dirname(location.binding.path), { bigint: true })))) throw new NoFileEffectError('父目录已变化。');
      }
      if (p.tree) await checkTree(scopes, p.binding, p.tree, ctx.signal);
      if ((p.operation === 'mkdir' && (await scopes.verify(p.binding)).stat)
        || (p.destination && (await scopes.verify(p.destination.binding)).stat)) throw new NoFileEffectError('目标已经存在，不会覆盖。');
      ctx.signal.throwIfAborted();
    };
    try {
      await check(); await host.beforeCommit?.(); await check();
      started = true;
      if (p.operation === 'trash') await host.trash(p.path);
      else if (p.operation === 'delete') await removeTree(scopes, p.binding, p.tree!, ctx.signal);
      else if (p.operation === 'mkdir') await mkdir(p.path, { mode: 0o700 });
      else {
        await copyTree(scopes, p.binding, p.destination!.binding, p.tree!, ctx.signal);
        if (p.operation === 'move') { await checkTree(scopes, p.binding, p.tree!, ctx.signal); await removeTree(scopes, p.binding, p.tree!, ctx.signal); }
      }
      committed = true; await host.afterCommit?.();
      // Once native IO succeeds, a later stop must not claim that no operation occurred.
      return { effectState: 'committed', content: [{ type: 'text', text: `${operationLabels[p.operation]}完成：${p.path}${p.destination ? ` → ${p.destination.binding.path}` : ''}` }],
        details: jsonCopy({ fileAccess: { format: 'dreamedge-file-result/v1', grantId: p.binding.grantId, rootId: p.binding.rootId,
          policyVersion: p.policyVersion, destination: p.binding.destination, path: p.path, entries: p.tree?.entries.length ?? 1,
          bytes: p.tree?.bytes ?? 0, skipped: 0, files: [] }, fileOperation: { planId: p.planId, planDigest: p.planDigest,
          operation: p.operation, path: p.path, ...(p.destination ? { destination: p.destination.binding.path } : {}), commit: 'confirmed' } }) };
    } catch (error) {
      if (!started) throw new NoFileEffectError(error instanceof NoFileEffectError ? error.message : '提交前检查失败，未执行结构变更。');
      if (!committed && p.operation === 'mkdir' && (error as NodeJS.ErrnoException).code === 'EEXIST') throw new NoFileEffectError('目标已经存在，未覆盖。');
      throw new Error('结构变更已启动，结果需核对；不会自动重放。');
    }
  });
}
