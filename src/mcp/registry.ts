import { freezeDeep, jsonCopy, canonicalJson } from '../tools/json.js';
import { parseMcpServerConfig, mcpConnectionIdentity } from './config.js';
import { object, id } from './validation.js';
import { appScope, checked, identity, McpRegistryError, parseMcpRegistry, sameMcpIdentity } from './registry-validation.js';
import { registrationBlock, resolveMcpContext } from './context-resolver.js';
import type { McpConnectionIdentity } from './types.js';
import type { McpRegistryState, McpRegistryStore, McpRegistration } from './registry-types.js';

/** Trusted host API; only storage changes occur. No renderer/Agent entry point is installed here. */
export class McpConnectionRegistry {
  private readonly listeners = new Set<() => void>();
  onChange(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  constructor(private readonly store: McpRegistryStore, private readonly now = Date.now) {}
  snapshot(): McpRegistryState { return this.store.load(); }
  register(input: unknown): McpRegistration { return this.registerMany([input])[0]!; }
  /** Explicitly selected imports are saved as one transaction; any conflict rejects the entire batch. */
  registerMany(inputs: readonly unknown[]): McpRegistration[] {
    const configs = checked(() => {
      if (!Array.isArray(inputs) || !inputs.length || inputs.length > 128) throw new McpRegistryError('INVALID_REGISTRY');
      return inputs.map(input => parseMcpServerConfig(input));
    });
    if (configs.some(c => c.configRevision !== 1)) throw new McpRegistryError('INVALID_REGISTRY');
    return this.change(state => {
      const ids = new Set(state.servers.map(s => s.config.serverId));
      const entries = configs.map(config => {
        if (ids.has(config.serverId)) throw new McpRegistryError('DUPLICATE'); ids.add(config.serverId);
        return { config, revoked: false };
      });
      state.servers.push(...entries); return entries;
    });
  }
  /** User-owned standard configuration is authoritative; reconciliation is a single durable transaction. */
  applyConfiguration(inputs: readonly unknown[], approveUnchanged = false): void {
    const configs = inputs.map(parseMcpServerConfig);
    if (new Set(configs.map(c => c.serverId)).size !== configs.length) throw new McpRegistryError('DUPLICATE');
    const previous = this.snapshot();
    const next = structuredClone(previous);
    const ids = new Set(configs.map(c => c.serverId));
    next.servers = next.servers.map(entry => {
      if (ids.has(entry.config.serverId) || (!entry.config.enabled && entry.revoked)) return entry;
      return { config: parseMcpServerConfig({ ...entry.config, enabled: false, configRevision: entry.config.configRevision + 1 }), revoked: true };
    });
    for (const config of configs) {
      const index = next.servers.findIndex(e => e.config.serverId === config.serverId), old = next.servers[index];
      const changed = !old || canonicalJson({ ...old.config, configRevision: 1 }) !== canonicalJson({ ...config, configRevision: 1 });
      if (!changed && !approveUnchanged && old!.revoked) continue;
      const current = parseMcpServerConfig({ ...config, configRevision: old ? old.config.configRevision + Number(changed) : 1 });
      const entry: McpRegistration = { config: current, revoked: false,
        ...(current.enabled && current.policy.connect !== 'deny' ? { approval: !changed && old?.approval ? old.approval
          : { identity: mcpConnectionIdentity(current), approvedAt: this.now() } } : {}) };
      if (index < 0) next.servers.push(entry); else next.servers[index] = entry;
    }
    if (canonicalJson(previous.servers) === canonicalJson(next.servers)) return;
    this.change(state => { if (state.revision !== previous.revision) throw new McpRegistryError('CONFLICT'); state.servers = next.servers; });
  }
  update(expected: McpConnectionIdentity, patch: unknown): McpRegistration {
    const changes = checked(() => object(jsonCopy(patch), ['displayName', 'enabled', 'protocolVersion', 'requestTimeoutMs', 'transport', 'policy'], 'patch'));
    if (!Object.keys(changes).length) throw new McpRegistryError('INVALID_REGISTRY');
    return this.change(state => {
      const entry = this.expected(state, expected);
      entry.config = parseMcpServerConfig({ ...entry.config, ...changes, configRevision: entry.config.configRevision + 1 });
      delete entry.approval; return entry;
    });
  }
  setEnabled(expected: McpConnectionIdentity, enabled: boolean): McpRegistration { return this.update(expected, { enabled }); }
  revoke(expected: McpConnectionIdentity): McpRegistration {
    return this.change(state => {
      const entry = this.expected(state, expected);
      entry.config = parseMcpServerConfig({ ...entry.config, configRevision: entry.config.configRevision + 1 });
      entry.revoked = true; delete entry.approval; return entry;
    });
  }
  /** Records an explicit host decision about this configuration; tool/resource approvals remain separate. */
  approveConnection(expected: McpConnectionIdentity): McpRegistration {
    return this.change(state => {
      const entry = this.expected(state, expected);
      if (!entry.config.enabled || entry.config.policy.connect === 'deny') throw new McpRegistryError('DENIED');
      entry.revoked = false; entry.approval = { identity: mcpConnectionIdentity(entry.config), approvedAt: this.now() }; return entry;
    });
  }
  associate(serverId: string, scope: unknown): void {
    const rule = checked(() => ({ ...appScope(jsonCopy(scope)), serverId: id(serverId, 'serverId') }));
    this.change(state => {
      if (!state.servers.some(s => s.config.serverId === rule.serverId)) throw new McpRegistryError('NOT_FOUND');
      if (!state.associations.some(r => canonicalJson(r) === canonicalJson(rule))) state.associations.push(rule);
    });
  }
  dissociate(serverId: string, scope: unknown): void {
    const rule = checked(() => ({ ...appScope(jsonCopy(scope)), serverId: id(serverId, 'serverId') }));
    this.change(state => { state.associations = state.associations.filter(r => canonicalJson(r) !== canonicalJson(rule)); });
  }
  pin(sessionId: string, expected: McpConnectionIdentity, scope?: unknown): void {
    const session = checked(() => id(sessionId, 'sessionId'));
    const target = scope === undefined ? undefined : checked(() => appScope(jsonCopy(scope)));
    this.change(state => {
      const entry = this.expected(state, expected); if (registrationBlock(entry)) throw new McpRegistryError('DENIED');
      state.bindings = state.bindings.filter(b => b.sessionId !== session);
      state.bindings.push({ sessionId: session, identity: mcpConnectionIdentity(entry.config), ...(target ? { scope: target } : {}) });
    });
  }
  unpin(sessionId: string): void {
    const session = checked(() => id(sessionId, 'sessionId'));
    this.change(state => { state.bindings = state.bindings.filter(b => b.sessionId !== session); });
  }
  resolve(input: Parameters<typeof resolveMcpContext>[1]) { return resolveMcpContext(this.snapshot(), { ...input, now: input.now ?? this.now() }); }
  private expected(state: McpRegistryState, value: McpConnectionIdentity): McpRegistration {
    const ref = checked(() => identity(jsonCopy(value))); const entry = state.servers.find(s => s.config.serverId === ref.serverId);
    if (!entry) throw new McpRegistryError('NOT_FOUND');
    if (!sameMcpIdentity(ref, mcpConnectionIdentity(entry.config))) throw new McpRegistryError('CONFLICT'); return entry;
  }
  private change<T>(mutate: (draft: McpRegistryState) => T): T {
    return checked(() => {
      const previous = this.store.load(), next = structuredClone(previous); const result = mutate(next);
      next.revision++; const validated = parseMcpRegistry(next); this.store.save(validated, previous.revision);
      for (const listener of this.listeners) { try { listener(); } catch { /* Observers cannot undo a committed registration. */ } }
      return freezeDeep(structuredClone(result));
    });
  }
}
