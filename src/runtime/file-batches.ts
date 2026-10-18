import type { ToolRunData } from './tool-contracts.js';
import type { PreparationServices, PreparedTool } from './tool-preparation.js';
import { prepareTool } from './tool-preparation.js';
import type { ToolApprovals } from './tool-approvals.js';
import type { ToolCallRecord } from '../tools/types.js';
import type { BatchRecoveryScope } from '../tools/batch-types.js';
import { isAccountMutation } from '../files/managed-tools.js';
import { previewPaths } from '../files/preview.js';
import { canonicalJson } from '../tools/json.js';
import { fileBatchPlan } from '../tools/batch-plan.js';
import { toolError } from './tool-executor.js';

/** Groups only concrete consecutive calls already emitted by Pi; never grants future unknown calls. */
export class FileBatches {
  private readonly claimed = new Set<string>();
  constructor(private readonly data: ToolRunData, private readonly services: PreparationServices,
    private readonly approvals: ToolApprovals, private readonly recovery?: BatchRecoveryScope) {}

  async before(call: ToolCallRecord, args: unknown): Promise<{ handled: boolean; allowed: boolean }> {
    if (call.status === 'authorized') {
      try {
        this.services.executor.preflight(call, this.data.toolsSnapshot.find(t => t.name === call.toolName)!, args);
        return { handled: true, allowed: this.approvals.authorized(call) };
      } catch { await this.reject([call], '批次调用参数与已确认计划不一致。'); return { handled: true, allowed: false }; }
    }
    if (this.recovery && call.effect === 'write' && !isAccountMutation(call.toolVersion)) {
      await this.reject([call], '恢复计划不能使用其他写入工具。'); return { handled: true, allowed: false };
    }
    if (call.status !== 'requested' || !isAccountMutation(call.toolVersion)) return { handled: false, allowed: false };
    const index = this.data.toolCalls.findIndex(item => item.toolCallId === call.toolCallId);
    const group: ToolCallRecord[] = [];
    for (const next of this.data.toolCalls.slice(index)) {
      if (next.turnId !== call.turnId || next.status !== 'requested' || !isAccountMutation(next.toolVersion)) break;
      group.push(next);
    }
    if (group.length < 2 && !this.recovery) return { handled: false, allowed: false };
    try {
      const prepared: PreparedTool[] = [];
      for (const item of group) {
        const snapshot = this.data.toolsSnapshot.find(tool => tool.name === item.toolName)!;
        const result = await prepareTool(this.services, item, snapshot, item === call ? args : item.args);
        if (this.recovery) {
          const target = this.recovery.items.find(entry => entry.toolName === item.toolName && entry.toolVersion === item.toolVersion
            && entry.argsDigest === item.argsDigest && entry.path === result.call.preview?.path
            && canonicalJson(entry.paths ?? [entry.path]) === canonicalJson(previewPaths(result.call.preview!)));
          if (!target || this.claimed.has(target.toolCallId)) throw new Error('Recovery target mismatch');
          this.claimed.add(target.toolCallId);
        }
        prepared.push(result);
      }
      const plan = fileBatchPlan(prepared);
      return { handled: true, allowed: await this.approvals.permitBatch(prepared, plan, Boolean(this.recovery)) };
    } catch {
      if (!this.services.signal.aborted) await this.reject(group, '批量计划检查未完成、目标重复或超出恢复范围，未执行本批操作。');
      return { handled: true, allowed: false };
    }
  }

  private async reject(calls: readonly ToolCallRecord[], reason: string) {
    for (const original of calls) {
      const call = this.data.toolCalls.find(c => c.toolCallId === original.toolCallId)!;
      if (!['requested', 'authorized'].includes(call.status)) continue;
      this.services.replace({ ...call, status: 'rejected', finishedAt: Date.now(), error: { code: 'DENIED', message: reason } });
      this.services.executor.outcomes.set(call.toolCallId, toolError('DENIED', reason));
    }
    await this.services.commit();
  }
}
