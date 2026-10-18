import { Type } from 'typebox';
import type { JsonObject } from '@earendil-works/pi-ai';
import type { ToolDefinition, ToolExecutionContext } from '../tools/types.js';
import type { FileScopeService } from './scope-service.js';
import { argumentsDigest, freezeDeep } from '../tools/json.js';
import { operationNames, operationVersion } from './operation-types.js';
import type { OperationHost, OperationPreview } from './operation-types.js';
import { previewOperation } from './operation-preview.js';
import { commitOperation } from './operation-commit.js';
import { inspectOperation } from './operation-policy.js';
import { NoFileEffectError } from './mutation-types.js';

const descriptions = {
  delete: 'Delete a file or directory. Defaults to the system trash. permanent=true irreversibly removes the exact inspected tree. Always requires confirmation. Never follows symlinks or skips protected children.',
  copy: 'Copy a file or directory to an absent destination, without overwriting. Parent directory must exist. The complete tree is inspected and copied using standard filesystem operations.',
  move: 'Move a file or directory to an absent destination. Copies without overwrite, verifies contents, then removes the inspected source. Partial failures require reconciliation; this is not a multi-path atomic rename.',
  mkdir: 'Create one directory. Its parent must exist and its target must not exist. Separate dependent operations into later turns.',
};
export function fileOperationTools(scopes: FileScopeService, host: OperationHost): readonly ToolDefinition[] {
  const plans = new Map<string, { preview: OperationPreview; claimed: boolean }>();
  const key = (ctx: ToolExecutionContext) => JSON.stringify([ctx.sessionId, ctx.runId, ctx.turnId, ctx.toolCallId]);
  return operationNames.map(name => freezeDeep({ name, version: operationVersion, label: { delete: '删除', move: '移动', copy: '复制', mkdir: '创建目录' }[name],
    description: `${descriptions[name]} Host pre-execution checks, batch approvals and cancellation apply. Maximum complete inventory: 1024 entries, depth 32, 1 GiB.`,
    parameters: Type.Object({ path: Type.String({ minLength: 1 }), ...(name === 'delete' ? { permanent: Type.Optional(Type.Boolean()) } : {}),
      ...(['copy', 'move'].includes(name) ? { destination: Type.String({ minLength: 1 }) } : {}) }, { additionalProperties: false }),
    effect: 'write' as const, approval: 'always' as const, resources: ['filesystem'], timeoutMs: 60_000, awaitCancellation: true,
    prepareApproval: async (args: JsonObject, ctx: ToolExecutionContext) => {
      if (plans.has(key(ctx))) throw new NoFileEffectError('同一调用不能重新生成计划。');
      const preview = await previewOperation(scopes, name, args, ctx); plans.set(key(ctx), { preview, claimed: false }); return preview;
    },
    inspectExecution: async (args: JsonObject, ctx: ToolExecutionContext) => {
      const plan = plans.get(key(ctx)); if (!plan || argumentsDigest(args) !== plan.preview.argsDigest) throw new NoFileEffectError('结构变更计划无效。');
      return inspectOperation(plan.preview);
    },
    execute: async (args: JsonObject, ctx: ToolExecutionContext) => {
      const plan = plans.get(key(ctx));
      if (!plan || plan.claimed || argumentsDigest(args) !== plan.preview.argsDigest) throw new NoFileEffectError('计划不存在、已执行或参数变化。');
      plan.claimed = true; return commitOperation(scopes, plan.preview, ctx, host);
    },
    release: async (ctx: ToolExecutionContext) => { plans.delete(key(ctx)); },
  }));
}
