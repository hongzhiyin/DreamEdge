import { bindMcpResources } from './resource-binding.js';
import type { ModelDestination } from '../model/destination.js';
import { McpInvocationGate } from './invocation-gate.js';
import { randomUUID } from 'node:crypto';
import { bindMcpTool } from './tool-binding.js';
import type { McpRunScope } from './tool-binding.js';
import { canonicalJson } from '../tools/json.js';
import { McpClient } from '@earendil-works/pi-mcp';
import type { McpTransport } from '@earendil-works/pi-mcp';
import { mcpClientOptions } from './pi-contract.js';
import { mcpConnectionIdentity } from './config.js';
import { connectionFailure, connectionWait, McpConnectionError } from './connection-errors.js';
import { discoverMcpCatalog } from './catalog.js';
import { GuardedMcpTransport } from './guarded-transport.js';
import { freezeDeep } from '../tools/json.js';
import type { McpServerConfig } from './types.js';
import type { McpConnectionView, McpHostTransportFactory } from './connection-types.js';

/** One conversation's connection generation; tool calls require a run scope and durable host authorization. */
export class ManagedMcpConnection {
  private readonly invocationGate = new McpInvocationGate();
  private readonly connectionId = randomUUID();
  readonly controller = new AbortController();
  private readonly client: McpClient;
  private transport?: GuardedMcpTransport;
  private view: McpConnectionView;
  private opening?: Promise<McpConnectionView>;
  private refreshing: Promise<McpConnectionView> | undefined;
  private closing?: Promise<void>;
  private changes = 0;
  private refreshQueued = false;
  private readonly unsubscribers: (() => void)[] = [];
  constructor(readonly sessionId: string, readonly config: McpServerConfig, generation: number,
    private readonly factory: McpHostTransportFactory, private readonly authorize: () => void,
    private readonly publish: (view: McpConnectionView) => void, private readonly startupMs: number) {
    this.client = new McpClient(mcpClientOptions(config));
    this.view = { sessionId, identity: mcpConnectionIdentity(config), generation, state: 'connecting', dirty: true };
    this.unsubscribers.push(this.client.onClose(() => {
      if (!this.controller.signal.aborted && this.view.state !== 'connecting') void this.stop('disconnected', new McpConnectionError('CLOSED'));
    }), this.client.onError(error => { if (!this.controller.signal.aborted) void this.fail(error); }));
    for (const name of ['notifications/tools/list_changed', 'notifications/resources/list_changed']) {
      this.unsubscribers.push(this.client.onNotification(name, () => this.invalidateCatalog()));
    }
  }
  snapshot(): McpConnectionView { return freezeDeep(structuredClone(this.view)); }
  bindTools(scope: McpRunScope) {
    const { captured, check } = this.capture(scope);
    return captured.catalog!.tools.filter(tool => tool.availability === 'compatible'
      && (!scope.readGrant || Object.hasOwn(scope.readGrant.toolSchemas, tool.definition.name))).map(tool =>
      bindMcpTool(captured, this.connectionId, tool, this.config.requestTimeoutMs, scope, check,
        async (name, args, options, check) => {
          const end = this.invocationGate.begin(check);
          try { return await this.client.callTool(name, args, options); } finally { end(); }
        }));
  }
  bindResources(scope: McpRunScope, destination: ModelDestination) {
    const { captured, check } = this.capture(scope);
    return bindMcpResources(captured, this.connectionId, this.config.requestTimeoutMs, destination, scope, check,
      async (uri, options, check) => {
        const end = this.invocationGate.begin(check);
        try { return await this.client.readResource(uri, options); } finally { end(); }
      });
  }
  private capture(scope: McpRunScope) {
    this.check(); const captured = this.snapshot();
    if (scope.sessionId !== this.sessionId || captured.state !== 'ready' || captured.dirty || !captured.catalog) {
      throw new McpConnectionError('INVALID_CATALOG');
    }
    const check = () => {
      this.check();
      if (this.view.state !== 'ready' || this.view.dirty || canonicalJson(this.view.catalog) !== canonicalJson(captured.catalog)) {
        throw new McpConnectionError('CONFIG_CHANGED');
      }
    };
    return { captured, check };
  }
  check = (): void => { this.controller.signal.throwIfAborted(); this.authorize(); };
  open(): Promise<McpConnectionView> { return this.opening ??= Promise.resolve().then(() => this.start()); }
  refresh(): Promise<McpConnectionView> {
    if (this.controller.signal.aborted) return Promise.resolve(this.snapshot());
    if (this.view.state === 'connecting') return this.open();
    return this.refreshing ??= Promise.resolve().then(() => this.loadCatalog()).finally(() => { this.refreshing = undefined; });
  }
  async stop(state: 'closed' | 'blocked' | 'failed' | 'auth-required' | 'disconnected', error?: McpConnectionError): Promise<void> {
    if (this.closing) return this.closing;
    this.view = { sessionId: this.sessionId, identity: mcpConnectionIdentity(this.config), generation: this.view.generation,
      state, dirty: true, ...(error ? { error: { code: error.code, message: error.message } } : {}) };
    this.closing = Promise.resolve().then(() => this.client.close()).catch(() => {});
    this.controller.abort(error ?? new McpConnectionError('CLOSED'));
    for (const dispose of this.unsubscribers.splice(0)) dispose();
    this.emit();
    return this.closing;
  }
  private async start(): Promise<McpConnectionView> {
    const timer = setTimeout(() => { void this.fail(new McpConnectionError('TIMEOUT')); }, this.startupMs);
    try {
      this.check(); this.emit();
      const creation = this.factory(this.config, { signal: this.controller.signal, check: this.authorize, checkToolRequest: id => this.invocationGate.beforeHttp(id) });
      void creation.then(raw => { if (this.controller.signal.aborted) void raw.close().catch(() => {}); }).catch(() => {});
      const raw: McpTransport = await connectionWait(creation, this.controller.signal);
      try { this.check(); } catch (error) { await raw.close().catch(() => {}); throw error; } this.transport = new GuardedMcpTransport(raw, this.check, error => { void this.fail(error); }, message => this.invocationGate.dispatch(message));
      this.transport.beginCatalog(); await connectionWait(this.client.connect(this.transport), this.controller.signal);
      this.check(); this.view.state = 'discovering'; this.emit(); await this.refresh();
    } catch (error) { await this.fail(error); }
    finally { clearTimeout(timer); }
    return this.snapshot();
  }
  private async loadCatalog(): Promise<McpConnectionView> {
    const timer = setTimeout(() => { void this.fail(new McpConnectionError('TIMEOUT')); }, this.config.requestTimeoutMs);
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        this.check(); const changedAt = this.changes; this.view.dirty = true; this.emit(); this.transport!.beginCatalog();
        const catalog = await discoverMcpCatalog(this.client, this.config, (this.view.catalog?.revision ?? 0) + 1, this.controller.signal);
        this.check(); if (changedAt !== this.changes) continue;
        this.view = { ...this.view, state: 'ready', dirty: false, catalog }; delete this.view.error;
        this.transport!.endCatalog(); this.emit(); return this.snapshot();
      }
      throw new McpConnectionError('LIMIT_EXCEEDED');
    } catch (error) { await this.fail(error); return this.snapshot(); }
    finally { clearTimeout(timer); }
  }
  private invalidateCatalog(): void {
    if (this.controller.signal.aborted) return;
    this.changes++; this.view.dirty = true; this.emit();
    if (this.view.state !== 'ready' || this.refreshing || this.refreshQueued) return;
    this.refreshQueued = true; queueMicrotask(() => { this.refreshQueued = false; if (!this.controller.signal.aborted) void this.refresh(); });
  }
  private async fail(error: unknown): Promise<void> {
    if (this.controller.signal.aborted) { await this.closing; return; }
    const safe = connectionFailure(error);
    await this.stop(safe.code === 'AUTH_REQUIRED' ? 'auth-required'
      : ['APPROVAL_REQUIRED', 'CONFIG_CHANGED', 'TARGET_DENIED'].includes(safe.code) ? 'blocked'
        : safe.code === 'CLOSED' ? 'disconnected' : 'failed', safe);
  }
  private emit(): void { try { this.publish(this.snapshot()); } catch { /* Observer failures do not change lifecycle decisions. */ } }
}
