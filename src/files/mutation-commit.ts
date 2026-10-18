import { managedMutationQueue } from './mutation-queue.js';
import { dirname } from 'node:path';
import { lstat } from 'node:fs/promises';
import { FsVersion } from '@deepseek-ai/dsh-fs';
import type { ToolExecutionContext, ToolResult } from '../tools/types.js';
import type { FileScopeService } from './scope-service.js';
import { readScopedFile } from './scoped-read.js';
import { fileIdentity, sameIdentity } from './scope-paths.js';
import { dshFileBackend } from './dsh-backend.js';
import { NoFileEffectError } from './mutation-types.js';
import type { MutationPlan } from './mutation-types.js';
import { contentHash } from './mutation-digest.js';
import type { FileVersion } from './scope-types.js';
import { canonicalJson, jsonCopy } from '../tools/json.js';

export interface MutationCommitHooks {
  beforePublish?(): Promise<void>; afterCommit?(): Promise<void>;
  configureBackend?(backend: ReturnType<typeof dshFileBackend>['filesystem']): void;
}
export async function commitMutation(scopes: FileScopeService, plan: MutationPlan, context: ToolExecutionContext,
  hooks: MutationCommitHooks = {}): Promise<ToolResult> {
  const p = plan.preview; let publication = false; let committed = false;
  const check = async () => {
    if (context.signal.aborted) throw new NoFileEffectError('变更在提交前已停止。');
    const permit = context.approval;
    if (!permit?.file || permit.file.planDigest !== p.planDigest || permit.file.planId !== p.planId
      || permit.file.policyVersion !== p.policyVersion || Date.now() >= permit.expiresAt) throw new NoFileEffectError('变更授权已失效，请重新预览。');
    if (contentHash(plan.content) !== p.afterSha256) throw new NoFileEffectError('暂存内容与批准的计划不一致。');
    const target = await scopes.verify(p.binding);
    if (!sameIdentity(fileIdentity(await lstat(dirname(p.path), { bigint: true })), p.parentIdentity)) throw new NoFileEffectError('目标父目录已变化。');
    if (p.before.kind === 'absent') { if (target.stat) throw new NoFileEffectError('新建目标已被其他写入创建。'); }
    else {
      if (!target.stat) throw new NoFileEffectError('目标文件已不存在。');
      const current = await readScopedFile(scopes, { ...p.binding, mode: 'read' }, context.signal, 4 * 1024 * 1024, false);
      if (canonicalJson(current.observation.version) !== canonicalJson(p.before.version)) throw new NoFileEffectError('文件版本已变化，请重新读取并预览。');
    }
  };
  const pi = await import('@earendil-works/pi-coding-agent');
  return managedMutationQueue(() => pi.withFileMutationQueue(p.path, async () => {
    const backend = dshFileBackend();
    try {
      await check(); const target = await backend.filesystem.resolve(p.path);
      if (target.targetKey !== p.path) throw new NoFileEffectError('目标真实路径已变化。');
      hooks.configureBackend?.(backend.filesystem);
      backend.filesystem.internals.inspectTemp = async () => { await hooks.beforePublish?.(); await check(); publication = true; };
      const outcome = await backend.filesystem.writeText(target, plan.content, p.before.kind === 'absent'
        ? { kind: 'createIfAbsent' } : { kind: 'replaceIfVersion', version: FsVersion(p.before.dshVersion) }, context.signal);
      committed = true; await hooks.afterCommit?.();
      let after: FileVersion | undefined;
      try {
        const captured = await readScopedFile(scopes, { ...p.binding, mode: 'read' }, new AbortController().signal, 4 * 1024 * 1024, false);
        if (captured.observation.version.sha256 === p.afterSha256) after = captured.observation.version;
      } catch { /* Commit is known; a revoked scope must not be bypassed to verify contents. */ }
      return { effectState: 'committed', content: [{ type: 'text', text: after ? `已提交并核对文件：${p.path}` : `文件已提交，当前状态未能核对：${p.path}` }],
        details: jsonCopy({ fileAccess: { format: 'dreamedge-file-result/v1', grantId: p.binding.grantId, rootId: p.binding.rootId,
          policyVersion: p.policyVersion, destination: p.binding.destination, path: p.path, entries: 1, bytes: p.afterBytes, skipped: 0,
          files: after ? [{ path: p.path, version: after, complete: p.operation !== 'edit' }] : [] },
        fileMutation: { planId: p.planId, planDigest: p.planDigest, commit: 'confirmed', verified: !!after, version: outcome.version } }) };
    } catch (error) {
      if (error instanceof NoFileEffectError && !committed) throw error;
      const code = (error as { code?: string }).code;
      if (!committed && (!publication || ['FS_STALE_VERSION', 'FS_NOT_OBSERVED', 'FS_ABORTED'].includes(code ?? ''))) {
        throw new NoFileEffectError('变更未发布；权限、版本或提交条件已变化。');
      }
      throw new Error('变更提交结果无法确认。');
    } finally { await backend.dispose(); }
  }));
}
