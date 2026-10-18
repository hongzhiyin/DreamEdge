import { modelDestination } from '../model/destination.js';
import { checkMcpHistory } from './history.js';
import type { PrepareRunTools, RunToolPreparation } from '../conversation/prepared-tools.js';
import type { AgentRuntime, ModelConnectionConfig } from '../model/types.js';
import type { McpConnectionIdentity } from './types.js';
import { ToolRegistry } from '../tools/registry.js';
import type { McpConnectionManager } from './connection-manager.js';
import { connectionWait, McpConnectionError } from './connection-errors.js';
import type { McpConnectionView } from './connection-types.js';
import type { McpRunScope } from './tool-binding.js';

export interface McpRunPreparationOptions {
  /** Host resolves explicit/context-selected connections with the existing registry resolver. */
  select(context: RunToolPreparation): readonly McpConnectionIdentity[] | Promise<readonly McpConnectionIdentity[]>;
  readonly baseRegistry: ToolRegistry;
  runtime(config: ModelConnectionConfig, registry: ToolRegistry): AgentRuntime;
  readGrant?(context: RunToolPreparation, identity: McpConnectionIdentity, view: McpConnectionView): NonNullable<McpRunScope['readGrant']>;
}

/** Per-run sealed registry; PiRuntime still owns the single Agent tool loop. */
export function createMcpRunPreparation(manager: McpConnectionManager, options: McpRunPreparationOptions): PrepareRunTools {
  const prepare: PrepareRunTools = async (config, context) => {
    const selected = structuredClone(await connectionWait(Promise.resolve(options.select(context)), context.signal));
    if (selected.length > 16 || new Set(selected.map(item => item.serverId)).size !== selected.length) {
      throw new McpConnectionError('LIMIT_EXCEEDED');
    }
    const registry = new ToolRegistry();
    for (const snapshot of context.tools) {
      const entry = options.baseRegistry.resolve(snapshot);
      registry.register({ ...snapshot, execute: entry.execute, awaitCancellation: entry.awaitCancellation,
        ...(entry.prepareApproval ? { prepareApproval: entry.prepareApproval } : {}),
        ...(entry.inspectExecution ? { inspectExecution: entry.inspectExecution } : {}),
        ...(entry.release ? { release: entry.release } : {}) });
    }
    for (const identity of selected) {
      context.signal.throwIfAborted();
      try {
        const view = await connectionWait(manager.open(context.sessionId, identity), context.signal);
        if (view.state !== 'ready' || view.dirty) throw new McpConnectionError(view.error?.code ?? 'UNAVAILABLE');
        const readGrant = options.readGrant?.(context, identity, view);
        const scope = readGrant ? { ...context, readGrant } : context;
        for (const tool of [...manager.bindTools(scope, identity),
          ...(readGrant ? [] : manager.bindResources(context, identity, modelDestination(config)))]) registry.register(tool);
      } catch (error) {
        // Connection preparation belongs to this session. Stop late initialization on cancellation.
        if (context.signal.aborted) void manager.disconnect(context.sessionId, identity.serverId);
        throw error;
      }
    }
    context.signal.throwIfAborted(); registry.seal();
    return Object.freeze({ tools: registry.snapshots(), runtime: options.runtime(config, registry) });
  };
  prepare.guardHistory = (runs, config, current) => checkMcpHistory(manager, runs, config, current);
  return prepare;
}
