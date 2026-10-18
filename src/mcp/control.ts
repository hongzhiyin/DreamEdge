import { McpJsonSettings, McpSettingsError } from './json-settings.js';
import { hasLegacyExternalData } from '../conversation/legacy-external.js';
import { McpConfigError } from './validation.js';
import { McpRegistryError } from './registry-validation.js';
class McpControlError extends Error {}
import type { ConversationService } from '../conversation/service.js';
import type { ModelConnectionConfig } from '../model/types.js';
import type { HostAdapter } from '../adapters/types.js';
import type { McpControlView } from './control-types.js';
import type { McpAppContext } from './registry-types.js';
import type { McpConnectionIdentity } from './types.js';
import { modelDestination } from '../model/destination.js';
import { McpConnectionRegistry } from './registry.js';
import { McpConnectionManager } from './connection-manager.js';
import { mcpConnectionIdentity } from './config.js';
import { object, id } from './validation.js';
import { identity, parseMcpAppContext, sameMcpIdentity } from './registry-validation.js';
import { ModelAdapterError } from '../model/errors.js';

/** Same command surface for trusted desktop IPC and authenticated local web clients; no raw tool calls. */
export class McpControl {
  private readonly pending = new Set<string>();
  private readonly contexts = new Map<string, McpAppContext>();
  constructor(readonly registry: McpConnectionRegistry, readonly manager: McpConnectionManager,
    private readonly service: () => ConversationService, private readonly connection: () => ModelConnectionConfig,
    private readonly adapters: readonly HostAdapter[] = [], private readonly settings?: McpJsonSettings) {}
  mode(sessionId: string): McpControlView['mode'] {
    if (this.registry.snapshot().bindings.some(b => b.sessionId === sessionId)) return 'external';
    const configured = this.settings?.snapshot();
    if (configured?.error || configured?.serverIds.length) return 'external';
    return this.notices(sessionId).length ? 'migration' : 'local';
  }
  select(sessionId: string): readonly McpConnectionIdentity[] {
    const configured = this.settings?.snapshot();
    if (configured?.error) throw new ModelAdapterError('TOOLS_NOT_ENABLED', configured.error);
    if (!this.registry.snapshot().bindings.some(b => b.sessionId === sessionId) && configured?.serverIds.length) {
      return this.registry.snapshot().servers.filter(s => configured.serverIds.includes(s.config.serverId)
        && s.config.enabled && !s.revoked && s.approval).map(s => mcpConnectionIdentity(s.config));
    }
    if (this.mode(sessionId) === 'local') return [];
    const result = this.registry.resolve({ sessionId });
    if (result.kind !== 'selected' || result.candidate.connectionPermission !== 'approved') {
      throw new ModelAdapterError('TOOLS_NOT_ENABLED', '请先在外部连接中选择并批准有效的 MCP 连接；不会回退到本机文件工具。');
    }
    return [result.candidate.identity];
  }
  snapshot(sessionId: string): McpControlView {
    this.service().getSnapshot(sessionId);
    const settings = this.settings?.snapshot();
    const state = this.registry.snapshot(), binding = state.bindings.find(b => b.sessionId === sessionId), context = this.contexts.get(sessionId);
    return { sessionId, revision: state.revision, mode: this.mode(sessionId), destination: modelDestination(this.connection()),
      ...(settings ? { settings } : {}), notices: this.notices(sessionId), associations: state.associations,
      servers: state.servers.map(entry => {
        const connection = this.manager.snapshot(sessionId, entry.config.serverId);
        return { ...entry, identity: mcpConnectionIdentity(entry.config), ...(connection ? { connection } : {}) };
      }), ...(binding ? { binding } : {}), ...(context ? { context, resolution: this.registry.resolve({ context, now: Date.now() }) } : {}) };
  }
  async request(input: unknown): Promise<McpControlView> {
    const value = input as { type?: unknown; sessionId?: unknown };
    const sessionId = id(value?.sessionId, 'sessionId');
    if (['snapshot', 'disconnect', 'revoke'].includes(String(value?.type))) return this.command(input);
    if (this.pending.has(sessionId)) throw new McpControlError('连接操作正在进行，请稍后重试。');
    this.pending.add(sessionId);
    try { return await this.command(input); } finally { this.pending.delete(sessionId); }
  }
  private async command(input: unknown): Promise<McpControlView> {
    const c = object(input, ['type', 'sessionId', 'config', 'patch', 'identity', 'enabled', 'scope', 'context', 'text'], 'command');
    const sessionId = id(c.sessionId, 'sessionId'); this.service().getSnapshot(sessionId);
    const type = String(c.type);
    const fields: Record<string, string[]> = { saveConfig: ['text'], use: ['identity'], snapshot: [], register: ['config'], update: ['identity', 'patch'],
      approve: ['identity'], enable: ['identity', 'enabled'], revoke: ['identity'], pin: ['identity'], unpin: [],
      connect: ['identity'], reconnect: ['identity'], disconnect: ['identity'], refresh: ['identity'],
      associate: ['identity', 'scope'], dissociate: ['identity', 'scope'], context: ['context'] };
    if (!Object.hasOwn(fields, type) || Object.keys(c).some(k => !['type', 'sessionId', ...fields[type]!].includes(k))) throw new McpControlError('连接命令无效。');
    if (type === 'snapshot') return this.snapshot(sessionId);
    if (!['disconnect', 'revoke'].includes(type)) this.editable(sessionId);
    const ref = c.identity === undefined ? undefined : identity(c.identity);
    const target = () => { if (!ref) throw new McpControlError('缺少连接身份。'); return ref; };
    if (type === 'saveConfig') {
      if (!this.settings || typeof c.text !== 'string') throw new McpControlError('缺少 MCP JSON 配置。');
      this.settings.save(c.text); this.registry.unpin(sessionId);
      for (const identity of this.select(sessionId)) await this.manager.open(sessionId, identity);
    } else if (type === 'use') {
      const entry = this.registry.approveConnection(target());
      this.registry.pin(sessionId, mcpConnectionIdentity(entry.config));
      const view = this.manager.snapshot(sessionId, entry.config.serverId);
      await this.manager[view && view.state !== 'ready' ? 'reconnect' : 'open'](sessionId, mcpConnectionIdentity(entry.config));
    } else if (type === 'register') this.registry.register(c.config);
    else if (type === 'update') this.registry.update(target(), c.patch);
    else if (type === 'approve') this.registry.approveConnection(target());
    else if (type === 'enable') { if (typeof c.enabled !== 'boolean') throw new McpControlError('启用状态无效。'); if (this.settings?.snapshot().serverIds.includes(target().serverId)) { this.current(target()); this.settings.setEnabled(target().serverId, c.enabled); }
      else this.registry.setEnabled(target(), c.enabled); }
    else if (type === 'revoke') this.registry.revoke(target());
    else if (type === 'pin') {
      const entry = this.registry.snapshot().servers.find(e => e.config.serverId === target().serverId);
      if (!entry?.approval) throw new McpControlError('请先批准此连接。'); this.registry.pin(sessionId, target());
    } else if (type === 'unpin') { await this.manager.closeSession(sessionId); this.editable(sessionId); this.registry.unpin(sessionId); }
    else if (type === 'connect' || type === 'reconnect') await this.manager[type === 'connect' ? 'open' : 'reconnect'](sessionId, target());
    else if (type === 'disconnect') { this.current(target()); await this.manager.disconnect(sessionId, target().serverId); }
    else if (type === 'refresh') { this.current(target()); await this.manager.refresh(sessionId, target().serverId); }
    else if (type === 'associate' || type === 'dissociate') { this.current(target()); this.registry[type](target().serverId, c.scope); }
    else if (type === 'context') {
      const data = object(c.context, ['appId', 'profileRef', 'windowRef', 'resourceRef', 'contextRevision'], 'context');
      this.contexts.set(sessionId, parseMcpAppContext({ ...data, source: 'user-selection', capturedAt: Date.now() }));
    }
    return this.snapshot(sessionId);
  }
  private current(expected: McpConnectionIdentity) {
    const entry = this.registry.snapshot().servers.find(e => e.config.serverId === expected.serverId);
    if (!entry || !sameMcpIdentity(mcpConnectionIdentity(entry.config), expected)) throw new McpControlError('连接版本已变化，请刷新。');
  }
  private editable(sessionId: string) {
    const state = this.service().getSnapshot(sessionId);
    if (!state.acceptingCommands || state.activeRunId || state.saveState.status !== 'saved') throw new McpControlError('请先停止当前运行并完成保存，再修改连接。');
  }
  private notices(sessionId: string) {
    const runs = this.service().getSnapshot(sessionId).runs;
    const notices = this.adapters.flatMap(adapter => { const message = adapter.notice(sessionId, runs); return message ? [message] : []; });
    return notices.length || !hasLegacyExternalData(runs) ? notices : ['此会话包含旧外部工具记录。请选择标准 MCP 连接；旧授权不会转为文件或新工具权限。'];
  }
}
export function mcpControlHandler(control: McpControl) {
  return async (command: unknown) => {
    try { return { ok: true as const, data: await control.request(command) }; }
    catch (error) { return { ok: false as const, error: { code: 'MCP_CONTROL_FAILED', message:
      error instanceof ModelAdapterError || error instanceof McpSettingsError || error instanceof McpConfigError || error instanceof McpRegistryError || error instanceof McpControlError ? error.message : '连接操作未完成。请检查配置、当前版本、批准状态和会话保存状态。' } }; }
  };
}
