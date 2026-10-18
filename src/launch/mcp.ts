import { argumentsDigest, canonicalJson } from '../tools/json.js';
import { modelDestination } from '../model/destination.js';
import { ModelAdapterError } from '../model/errors.js';
import type { ModelConnectionConfig, CredentialResolver } from '../model/types.js';
import type { ConversationService } from '../conversation/service.js';
import { ToolRegistry } from '../tools/registry.js';
import { PiRuntime } from '../runtime/pi-runtime.js';
import { McpConnectionRegistry } from '../mcp/registry.js';
import { McpConnectionManager } from '../mcp/connection-manager.js';
import { mcpConnectionIdentity } from '../mcp/config.js';
import { createMcpRunPreparation } from '../mcp/run-preparation.js';
import type { McpConnectionView } from '../mcp/connection-types.js';
import type { McpServerConfig } from '../mcp/types.js';
import { LaunchStore } from './store.js';
import { launchTrustDestination } from './mcp-offer.js';
import { LaunchError, contextKey, type OpenSession } from './protocol.js';
import { readGrantDigest } from './grant.js';

function approvedCatalog(view: McpConnectionView, request: OpenSession) {
  if (view.state !== 'ready' || view.dirty || !view.catalog) throw new LaunchError('MCP_UNAVAILABLE', '应用内容服务尚未就绪，请确认原窗口仍打开后重连。');
  const tools = [...request.mcp!.readTools, ...(request.mcp!.interactionTools ?? [])].map(name => view.catalog!.tools.find(t => t.definition.name === name));
  if (tools.some(t => !t || t.availability !== 'compatible')) throw new LaunchError('MCP_INCOMPATIBLE', '应用声明的读取能力不存在或格式不兼容。');
  return { toolSchemas: Object.fromEntries(tools.map(t => [t!.definition.name, t!.schemaDigest])),
    definitionsDigest: argumentsDigest(tools.map(t => t!.definition)) };
}
/** Isolated registry: ordinary MCP JSON changes cannot replace a launch grant. */
export class LaunchMcp {
  readonly prepare;
  constructor(private readonly store: LaunchStore, readonly registry: McpConnectionRegistry,
    readonly manager: McpConnectionManager, private readonly service: () => ConversationService,
    private readonly config: () => ModelConnectionConfig, credentials: CredentialResolver) {
    this.prepare = createMcpRunPreparation(manager, { baseRegistry: new ToolRegistry(),
      select: context => [this.check(context.sessionId).identity],
      runtime: (config, registry) => new PiRuntime(config, credentials, { registry }),
      readGrant: (context, _identity, view) => {
        const grant = this.check(context.sessionId), catalog = approvedCatalog(view, grant.request);
        if (catalog.definitionsDigest !== grant.definitionsDigest) throw new ModelAdapterError('INVALID_CONTEXT', '应用读取能力已变化，请从原应用重连并确认。');
        return { digest: readGrantDigest(grant), toolSchemas: grant.toolSchemas,
          interactionTools: grant.request.mcp?.interactionTools ?? [], check: () => {
          const current = this.check(context.sessionId);
          if (canonicalJson(current) !== canonicalJson(grant)) throw new ModelAdapterError('INVALID_CONTEXT', '应用读取授权已变化。');
        } };
      } });
    const history = this.prepare.guardHistory;
    this.prepare.guardHistory = (runs, config, current) => {
      const id = runs[0]?.sessionId;
      if (id) {
        const digest = readGrantDigest(this.check(id));
        if (runs.some(run => run.toolsSnapshot?.some(tool => tool.origin && (tool.origin.readGrantDigest ?? tool.origin.interactionGrantDigest) !== digest))) {
          throw new ModelAdapterError('INVALID_CONTEXT', '历史内容不属于当前应用读取授权，请恢复原授权或新建会话。');
        }
      }
      history?.(runs, config, current);
    };
  }
  check(sessionId: string) {
    const grant = this.store.grant(sessionId), destination = JSON.stringify(modelDestination(this.config()));
    if (!grant || grant.revoked || grant.destination !== destination
      || !this.store.trusted(grant.request.application, launchTrustDestination(destination, grant.request.mcp))) {
      throw new ModelAdapterError('INVALID_CONTEXT', '应用内容授权已失效，请从原应用重新打开会话并确认。');
    }
    return grant;
  }
  async connect(request: OpenSession, sessionId: string, confirmChanged: () => Promise<boolean>): Promise<void> {
    if (!request.mcp) throw new LaunchError('MCP_UNAVAILABLE', '缺少应用内容服务。');
    const state = this.service().getSnapshot(sessionId);
    if (state.activeRunId) throw new LaunchError('SESSION_BUSY', '会话正在执行，请停止后重连。');
    const serverId = 'handoff-' + argumentsDigest({ context: contextKey(request), offer: request.mcp }).slice(0, 40);
    const config: McpServerConfig = { format: 'dreamedge-mcp-server/v1', serverId, configRevision: 1,
      displayName: request.application.name, enabled: true, protocolVersion: '2025-11-25', requestTimeoutMs: 20_000,
      transport: { ...request.mcp.transport, envRefs: {} }, policy: { connect: 'ask', tools: 'ask', resources: 'deny' } };
    const entry = this.registry.snapshot().servers.find(e => e.config.serverId === serverId) ?? this.registry.register(config);
    this.registry.approveConnection(mcpConnectionIdentity(entry.config));
    const identity = mcpConnectionIdentity(entry.config), old = this.manager.snapshot(sessionId, serverId);
    const view = await (old && old.state !== 'ready' ? this.manager.reconnect(sessionId, identity) : this.manager.open(sessionId, identity));
    const catalog = approvedCatalog(view, request), previous = this.store.grant(sessionId);
    if (previous && !previous.revoked && previous.definitionsDigest !== catalog.definitionsDigest && !await confirmChanged()) {
      await this.manager.closeSession(sessionId); throw new LaunchError('TRUST_DENIED', '读取能力变化未获批准。');
    }
    const next = { request, identity, ...catalog, revoked: false, destination: JSON.stringify(modelDestination(this.config())) };
    if (previous && state.messages.length && readGrantDigest(previous) !== readGrantDigest(next)) {
      await this.manager.closeSession(sessionId);
      throw new LaunchError('CONTEXT_RESTART_REQUIRED', '读取范围或模型目的地已变化，需要新的会话。');
    }
    this.store.saveGrant(sessionId, next);
  }
  async revoke(sessionIds: string[]) {
    for (const id of sessionIds) {
      const grant = this.store.grant(id); if (grant) this.store.saveGrant(id, { ...grant, revoked: true });
      this.service().stop(id); await this.manager.closeSession(id);
    }
  }
}
