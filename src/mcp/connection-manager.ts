import type { ModelDestination } from '../model/destination.js';
import type { McpToolOrigin } from '../tools/mcp-origin.js';
import type { McpRunScope } from './tool-binding.js';
import type { McpConnectionRegistry } from './registry.js';
import { mcpConnectionIdentity } from './config.js';
import { registrationBlock } from './context-resolver.js';
import { checked, identity, sameMcpIdentity } from './registry-validation.js';
import { id } from './validation.js';
import { jsonCopy } from '../tools/json.js';
import type { McpConnectionIdentity } from './types.js';
import type { McpConnectionOptions, McpConnectionView, McpHostTransportFactory } from './connection-types.js';
import { McpConnectionError } from './connection-errors.js';
import { createMcpTransportFactory } from './connection-transport.js';
import { ManagedMcpConnection } from './managed-connection.js';

export class McpConnectionManager {
  private readonly retiring = new Set<Promise<void>>();
  private readonly entries = new Map<string, ManagedMcpConnection>();
  private readonly factory: McpHostTransportFactory;
  private readonly unsubscribe: () => void;
  private generation = 0;
  private disposed = false;
  constructor(private readonly registry: McpConnectionRegistry, private readonly options: McpConnectionOptions = {}) {
    if (options.startupTimeoutMs !== undefined && (!Number.isSafeInteger(options.startupTimeoutMs) || options.startupTimeoutMs < 1)) throw new McpConnectionError('TIMEOUT');
    this.options = Object.freeze({ ...options });
    this.factory = this.options.transportFactory ?? createMcpTransportFactory(this.options);
    this.unsubscribe = registry.onChange(() => this.reconcile());
  }
  /** Reuses a healthy generation. A stopped/failed generation needs an explicit reconnect. */
  open(sessionId: string, expected: McpConnectionIdentity): Promise<McpConnectionView> { return this.connect(sessionId, expected, false); }
  reconnect(sessionId: string, expected: McpConnectionIdentity): Promise<McpConnectionView> { return this.connect(sessionId, expected, true); }
  snapshot(sessionId: string, serverId: string): McpConnectionView | undefined {
    this.reconcile(); return this.entries.get(this.key(sessionId, serverId))?.snapshot();
  }
  bindTools(scope: McpRunScope, expected: McpConnectionIdentity) {
    this.approved(expected); this.reconcile();
    const entry = this.entries.get(this.key(scope.sessionId, expected.serverId));
    if (!entry || !sameMcpIdentity(mcpConnectionIdentity(entry.config), expected)) throw new McpConnectionError('CLOSED');
    return entry.bindTools(scope);
  }
  bindResources(scope: McpRunScope, expected: McpConnectionIdentity, destination: ModelDestination) {
    this.approved(expected); this.reconcile();
    const entry = this.entries.get(this.key(scope.sessionId, expected.serverId));
    if (!entry || !sameMcpIdentity(mcpConnectionIdentity(entry.config), expected)) throw new McpConnectionError('CLOSED');
    return entry.bindResources(scope, destination);
  }
  /** Historical content may be reused only under its original active configuration and policy. No network I/O. */
  assertHistory(sessionId: string, origin: McpToolOrigin): void {
    if (this.disposed) throw new McpConnectionError('CLOSED');
    const config = this.approved({ serverId: origin.serverId, configRevision: origin.configRevision, configDigest: origin.configDigest });
    if (config.policy[origin.kind === 'mcp-resource' ? 'resources' : 'tools'] === 'deny') throw new McpConnectionError('TARGET_DENIED');
    const state = this.snapshot(sessionId, origin.serverId)?.state;
    if (state && state !== 'ready') throw new McpConnectionError('CLOSED');
  }
  async refresh(sessionId: string, serverId: string): Promise<McpConnectionView> {
    this.reconcile(); const entry = this.entries.get(this.key(sessionId, serverId));
    if (!entry) throw new McpConnectionError('CLOSED'); return entry.refresh();
  }
  async disconnect(sessionId: string, serverId: string): Promise<void> {
    await this.entries.get(this.key(sessionId, serverId))?.stop('closed');
  }
  async closeSession(sessionId: string): Promise<void> {
    checked(() => id(sessionId, 'sessionId'));
    await Promise.all([...this.entries.entries()].filter(([, entry]) => entry.sessionId === sessionId).map(async ([key, entry]) => {
      await this.retire(entry); if (this.entries.get(key) === entry) this.entries.delete(key);
    }));
  }
  async dispose(): Promise<void> {
    this.disposed = true; this.unsubscribe();
    const closing = [...this.entries.values()].map(entry => this.retire(entry)); await Promise.all([...closing, ...this.retiring]);
  }
  private async connect(sessionId: string, value: McpConnectionIdentity, replace: boolean): Promise<McpConnectionView> {
    if (this.disposed) throw new McpConnectionError('CLOSED');
    const expected = checked(() => identity(jsonCopy(value))); const key = this.key(sessionId, expected.serverId);
    const config = this.approved(expected); const previous = this.entries.get(key);
    if (!replace && previous && sameMcpIdentity(mcpConnectionIdentity(previous.config), expected)) {
      const state = previous.snapshot().state;
      return state === 'connecting' || state === 'discovering' ? previous.open() : previous.snapshot();
    }
    if (!previous && this.entries.size >= 64) throw new McpConnectionError('LIMIT_EXCEEDED');
    const stopped = previous ? this.retire(previous) : Promise.resolve();
    const check = () => { this.approved(expected); };
    const entry = new ManagedMcpConnection(sessionId, config, ++this.generation,
      async (config, context) => { await stopped; context.signal.throwIfAborted(); context.check(); return this.factory(config, context); }, check,
      view => { if (!this.disposed && this.entries.get(key) === entry) this.options.onChange?.(view); },
      Math.min(this.options.startupTimeoutMs ?? config.requestTimeoutMs, config.requestTimeoutMs));
    this.entries.set(key, entry); return entry.open();
  }
  private approved(expected: McpConnectionIdentity) {
    try {
      const entry = this.registry.snapshot().servers.find(s => s.config.serverId === expected.serverId);
      if (!entry || registrationBlock(entry) || !sameMcpIdentity(mcpConnectionIdentity(entry.config), expected)) throw new McpConnectionError('CONFIG_CHANGED');
      if (!entry.approval || !sameMcpIdentity(entry.approval.identity, expected)) throw new McpConnectionError('APPROVAL_REQUIRED');
      return entry.config;
    } catch (error) { if (error instanceof McpConnectionError) throw error; throw new McpConnectionError('CONFIG_CHANGED'); }
  }
  private reconcile(): void {
    for (const entry of this.entries.values()) {
      if (entry.controller.signal.aborted) continue;
      try { this.approved(mcpConnectionIdentity(entry.config)); }
      catch (error) { void entry.stop('blocked', error as McpConnectionError); }
    }
  }
  private retire(entry: ManagedMcpConnection): Promise<void> {
    const closing = entry.stop('closed'); this.retiring.add(closing);
    void closing.finally(() => this.retiring.delete(closing)); return closing;
  }
  private key(sessionId: string, serverId: string): string { return checked(() => JSON.stringify([id(sessionId, 'sessionId'), id(serverId, 'serverId')])); }
}
