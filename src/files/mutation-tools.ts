import type { JsonObject } from '@earendil-works/pi-ai';
import type { ToolDefinition, ToolExecutionContext } from '../tools/types.js';
import type { FileScopeService } from './scope-service.js';
import { loadPiFileTools } from './pi-file-tools.js';
import { previewMutation } from './mutation-preview.js';
import { commitMutation } from './mutation-commit.js';
import type { MutationCommitHooks } from './mutation-commit.js';
import { NoFileEffectError, mutationVersion, mutationToolNames } from './mutation-types.js';
import type { MutationName, MutationPlan } from './mutation-types.js';
import type { MutationPolicy } from './mutation-policy.js';
import { accountMutationVersion } from './mutation-policy.js';
import { argumentsDigest, freezeDeep } from '../tools/json.js';

export async function scopedMutationTools(scopes: FileScopeService, hooks: MutationCommitHooks = {}, policy?: MutationPolicy): Promise<readonly ToolDefinition[]> {
  const plans = new Map<string, MutationPlan>(); const key = (ctx: ToolExecutionContext) => JSON.stringify([ctx.sessionId, ctx.runId, ctx.turnId, ctx.toolCallId]);
  const denied = async (): Promise<never> => { throw new NoFileEffectError('变更需要预览与一次性授权。'); };
  const metadata = (await loadPiFileTools({ authorize: denied, prepare: denied })).filter(t => mutationToolNames.includes(t.name as MutationName));
  return Object.freeze(metadata.map(tool => freezeDeep({ ...tool, version: policy ? accountMutationVersion : mutationVersion, timeoutMs: 30_000, awaitCancellation: true,
    description: `${tool.description} ${policy ? 'Files use the OS account permissions. Host policy automatically allows ordinary creation and local edits; sensitive effects require user confirmation.' : 'Session read-write scope and one-shot preview approval are required.'} Parent directory must already exist. Existing targets require a fresh prior read; overwrites require a complete view. UTF-8 text only.`,
    prepareApproval: async (args: JsonObject, ctx: ToolExecutionContext) => {
      if (plans.has(key(ctx))) throw new NoFileEffectError('同一调用不能重新生成已确认计划。');
      const plan = await previewMutation(scopes, tool.name as MutationName, args, ctx); plans.set(key(ctx), plan); return plan.preview;
    },
    ...(policy ? { inspectExecution: async (args: JsonObject, ctx: ToolExecutionContext) => {
      const plan = plans.get(key(ctx));
      if (!plan || plan.claimed || argumentsDigest(args) !== plan.preview.argsDigest) throw new NoFileEffectError('缺少有效的文件检查计划。');
      await scopes.verify(plan.preview.binding);
      return policy(plan);
    } } : {}),
    release: async (ctx: ToolExecutionContext) => { plans.delete(key(ctx)); },
    execute: async (args: JsonObject, ctx: ToolExecutionContext) => {
      const plan = plans.get(key(ctx));
      if (!plan || plan.claimed || argumentsDigest(args) !== plan.preview.argsDigest) throw new NoFileEffectError('变更计划不存在、已消费或参数不一致。');
      plan.claimed = true; return commitMutation(scopes, plan, ctx, hooks);
    },
  })));
}
