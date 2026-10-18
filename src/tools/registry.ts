import type { Static, TSchema } from 'typebox';
import type { JsonObject } from '@earendil-works/pi-ai';
import { canonicalJson } from './json.js';
import { toolSnapshot } from './snapshot.js';
import { ToolContractError } from './errors.js';
import type { ToolDefinition, ToolExecutionContext, ToolResult, ToolSnapshot } from './types.js';

interface RegisteredTool {
  readonly awaitCancellation: boolean;
  readonly snapshot: ToolSnapshot;
  prepareApproval?: ToolDefinition['prepareApproval'];
  inspectExecution?: ToolDefinition['inspectExecution'];
  release?: ToolDefinition['release'];
  execute(args: JsonObject, context: ToolExecutionContext): Promise<ToolResult>;
}

/** Host-owned callbacks; only serializable definitions cross into a model request. */
export class ToolRegistry {
  private sealed = false;
  seal(): void { this.sealed = true; }
  private readonly entries = new Map<string, RegisteredTool>();

  register<T extends TSchema>(definition: ToolDefinition<T>): void {
    if (this.sealed) throw new ToolContractError('INVALID_TOOL_DEFINITION', '工具注册表已封闭，其他入口须显式接入宿主检查。');
    const snapshot = toolSnapshot(definition);
    if (this.entries.has(snapshot.name)) throw new ToolContractError('DUPLICATE_TOOL', '工具名称已注册。');
    if (typeof definition.execute !== 'function') throw new ToolContractError('INVALID_TOOL_DEFINITION', '工具处理函数无效。');
    const execute = definition.execute.bind(definition);
    this.entries.set(snapshot.name, Object.freeze({ snapshot, awaitCancellation: definition.awaitCancellation === true,
      ...(definition.prepareApproval ? { prepareApproval: definition.prepareApproval.bind(definition) } : {}),
      ...(definition.inspectExecution ? { inspectExecution: definition.inspectExecution.bind(definition) } : {}),
      ...(definition.release ? { release: definition.release.bind(definition) } : {}),
      execute: (args: JsonObject, context: ToolExecutionContext) => execute(args as Static<T>, context) }));
  }

  snapshots(names: readonly string[] = [...this.entries.keys()]): readonly ToolSnapshot[] {
    if (new Set(names).size !== names.length) throw new ToolContractError('DUPLICATE_TOOL', '启用工具名称重复。');
    return Object.freeze(names.map(name => {
      const tool = this.entries.get(name);
      if (!tool) throw new ToolContractError('UNKNOWN_TOOL', '指定工具未注册。');
      return tool.snapshot;
    }));
  }

  resolve(snapshot: ToolSnapshot): RegisteredTool {
    const registered = this.entries.get(snapshot.name);
    if (!registered || canonicalJson(registered.snapshot) !== canonicalJson(snapshot)) {
      throw new ToolContractError('UNKNOWN_TOOL', '工具定义或版本与运行快照不一致。');
    }
    return registered;
  }
}
