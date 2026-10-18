import { randomUUID } from 'node:crypto';
import type { SessionState } from '../conversation/state.js';
import type { ModelConnectionConfig } from '../model/types.js';
import type { ToolCallIdentity } from '../tools/types.js';
import { freezeDeep } from '../tools/json.js';
import { inspectPath, inspectRoot, sameIdentity, excluded } from './scope-paths.js';
import { assertFileScope, exclusion, sameDestination } from './scope-validation.js';
import { containsPath } from './scope-paths.js';
import { isAbsolute, resolve } from 'node:path';
import { syncDeviceGrants } from './device-grants.js';
import { devicePath } from './device-path.js';
import { emptyFileScope, FileScopeError, fileDestination } from './scope-types.js';
import type { FileVersion, FileScopeOverview, DeviceAccessPolicy } from './scope-types.js';
import type { DirectoryPicker, FileAccessBinding, FileGrantOptions, FileScopeGrant, FileScopeState, FileObservation } from './scope-types.js';

export interface FileScopeOwner {
  state(sessionId: string): SessionState;
  connection(id: string): ModelConnectionConfig;
  changed(state: SessionState): boolean;
  requireOpen(): void;
  deviceAccess?(config: ModelConnectionConfig): DeviceAccessPolicy | undefined;
}
/** Session policy owns grants; tool approvals remain independent, per-call records. */
export class FileScopeService {
  constructor(private readonly owner: FileScopeOwner, private readonly now: () => number,
    private readonly picker?: DirectoryPicker) {}
  snapshot(sessionId: string): FileScopeState { return structuredClone(this.scope(this.owner.state(sessionId))); }
  overview(sessionId: string): FileScopeOverview {
    const state = this.owner.state(sessionId); const scope = this.scope(state);
    const policy = this.owner.deviceAccess?.(this.owner.connection(state.session.connectionId));
    return structuredClone({ policyVersion: scope.policyVersion,
      ...(this.owner.deviceAccess ? { device: { available: true, enabled: Boolean(policy),
        ...(policy ? { baseDirectory: policy.baseDirectory, ...(policy.mode ? { mode: policy.mode } : {}) } : {}) } } : {}),
      destination: fileDestination(this.owner.connection(state.session.connectionId)),
      grants: scope.grants.map(({ identity: _identity, rootId: _rootId, ...grant }) => grant) });
  }
  syncDeviceAccess(sessionId: string, strict = false): void {
    this.owner.requireOpen(); const state = this.owner.state(sessionId);
    if (!strict && ['failed', 'pending'].includes(state.saveState.status)) return;
    this.ready(state);
    const next = structuredClone(this.scope(state)); const config = this.owner.connection(state.session.connectionId);
    if (!syncDeviceGrants(next, sessionId, fileDestination(config), this.owner.deviceAccess?.(config), this.now())) return;
    state.session.fileScope = next; this.save(state);
  }
  async chooseDirectory(sessionId: string, options: FileGrantOptions): Promise<FileScopeGrant | undefined> {
    this.owner.requireOpen(); const state = this.owner.state(sessionId); this.ready(state);
    if (!this.picker) throw new FileScopeError('FILE_SCOPE_DENIED', '宿主未提供目录选择器。');
    const createdAt = this.now();
    if (!options || !['read', 'read-write'].includes(options.mode) || typeof options.remember !== 'boolean'
      || (options.expiresAt !== undefined && (!Number.isFinite(options.expiresAt) || options.expiresAt <= createdAt))
      || (options.excludes !== undefined && (!Array.isArray(options.excludes) || options.excludes.length > 128
        || !options.excludes.every(exclusion)))) throw new FileScopeError('FILE_SCOPE_INVALID', '目录授权参数无效。');
    const config = this.owner.connection(state.session.connectionId); const destination = fileDestination(config);
    const selected = await this.picker(sessionId, structuredClone(options)); if (selected === undefined) return;
    const root = await inspectRoot(selected);
    this.owner.requireOpen(); this.ready(state);
    if (!sameDestination(destination, fileDestination(this.owner.connection(state.session.connectionId)))) this.stale();
    const scope = this.scope(state); if (scope.grants.length >= 64) throw new FileScopeError('FILE_SCOPE_INVALID', '目录授权数量已达上限。');
    const grant: FileScopeGrant = { grantId: randomUUID(), rootId: randomUUID(), sessionId, ...root,
      mode: options.mode, remember: options.remember, excludes: [...(options.excludes ?? [])], destination, createdAt,
      ...(options.expiresAt === undefined ? {} : { expiresAt: options.expiresAt }) };
    if (excluded(grant, grant.path)) throw new FileScopeError('FILE_SCOPE_DENIED', '所选目录属于默认排除范围。');
    scope.grants.push(grant); scope.policyVersion++; state.session.fileScope = scope; this.save(state);
    return structuredClone(grant);
  }
  revoke(sessionId: string, grantId: string): void {
    this.owner.requireOpen(); const state = this.owner.state(sessionId); const scope = this.scope(state);
    const grant = scope.grants.find(g => g.grantId === grantId);
    if (!grant) throw new FileScopeError('FILE_SCOPE_DENIED', '目录授权不存在。');
    if (grant.revokedAt !== undefined) return;
    grant.revokedAt = Math.max(this.now(), grant.createdAt); scope.policyVersion++; this.save(state);
  }
  async bind(source: ToolCallIdentity, grantId: string, input: string, mode: 'read' | 'write'): Promise<FileAccessBinding> {
    const state = this.owner.state(source.sessionId); this.ready(state);
    if (state.active?.runId !== source.runId || !source.turnId || !source.toolCallId) this.stale();
    const scope = this.scope(state); const version = scope.policyVersion;
    const grant = this.grant(state, grantId, mode);
    const { path } = await inspectPath(grant, input, mode === 'write');
    if (mode === 'write') this.checkHostProtection(state, path);
    this.ready(state); this.grant(state, grantId, mode);
    if (scope.policyVersion !== version || state.active?.runId !== source.runId) this.stale();
    return freezeDeep({ sessionId: source.sessionId, runId: source.runId, turnId: source.turnId, toolCallId: source.toolCallId, grantId, rootId: grant.rootId, policyVersion: version, root: grant.path, path, mode,
      destination: structuredClone(grant.destination), rootIdentity: structuredClone(grant.identity) });
  }
  async verify(binding: FileAccessBinding) {
    this.owner.requireOpen(); const state = this.owner.state(binding.sessionId); this.ready(state);
    const scope = this.scope(state); const grant = this.grant(state, binding.grantId, binding.mode);
    if (scope.policyVersion !== binding.policyVersion || state.active?.runId !== binding.runId
      || binding.rootId !== grant.rootId || binding.root !== grant.path || !sameIdentity(binding.rootIdentity, grant.identity)
      || !sameDestination(binding.destination, grant.destination)) this.stale();
    if (binding.mode === 'write') this.checkHostProtection(state, binding.path);
    const target = await inspectPath(grant, binding.path, binding.mode === 'write');
    this.ready(state); this.grant(state, binding.grantId, binding.mode);
    if (scope.policyVersion !== binding.policyVersion || state.active?.runId !== binding.runId) this.stale();
    return target;
  }
  roots(sessionId: string, config = this.owner.connection(this.owner.state(sessionId).session.connectionId)): FileScopeGrant[] {
    const device = Boolean(this.owner.deviceAccess?.(config));
    return structuredClone(this.scope(this.owner.state(sessionId)).grants.filter(g => g.revokedAt === undefined
      && Boolean(g.device) === device && (g.expiresAt === undefined || g.expiresAt > this.now()) && sameDestination(g.destination, fileDestination(config))));
  }
  async bindRead(source: ToolCallIdentity, input = '.'): Promise<FileAccessBinding> {
    const roots = this.roots(source.sessionId);
    if (roots.some(root => root.device)) input = await devicePath(roots, input);
    const candidates = isAbsolute(input) ? roots.filter(root => containsPath(root.path, resolve(input))).sort((a, b) => b.path.length - a.path.length) : roots;
    if (!candidates.length || (!isAbsolute(input) && candidates.length !== 1)) {
      throw new FileScopeError('FILE_SCOPE_DENIED', '没有可读取目录，或多个目录需要使用绝对路径。');
    }
    return this.bind(source, candidates[0]!.grantId, input, 'read');
  }
  async bindWrite(source: ToolCallIdentity, input: string): Promise<FileAccessBinding> {
    const roots = this.roots(source.sessionId).filter(root => root.mode === 'read-write');
    if (roots.some(root => root.device)) input = await devicePath(roots, input);
    const candidates = isAbsolute(input) ? roots.filter(root => containsPath(root.path, resolve(input))).sort((a, b) => b.path.length - a.path.length) : roots;
    if (!candidates.length || (!isAbsolute(input) && candidates.length !== 1)) throw new FileScopeError('FILE_SCOPE_DENIED', '没有可写目录，或多个目录需要使用绝对路径。');
    return this.bind(source, candidates[0]!.grantId, input, 'write');
  }
  wasObserved(sessionId: string, path: string, version: FileVersion, full: boolean): boolean {
    const state = this.owner.state(sessionId);
    return state.runs.some(run => run.toolCalls?.some(call => {
      if (call.status !== 'succeeded' || !['pi-1.1.0/scoped-read-1', 'pi-1.1.0/scoped-mutation-1', 'pi-1.1.0/account-mutation-1'].includes(call.toolVersion)) return false;
      const result = call.result.details as { fileAccess?: { files?: { path: string; version: FileVersion; complete: boolean }[] } };
      return result?.fileAccess?.files?.some(file => file.path === path && file.version.sha256 === version.sha256
        && file.version.device === version.device && file.version.inode === version.inode && file.version.size === version.size
        && file.version.modifiedNs === version.modifiedNs && file.version.changedNs === version.changedNs && (!full || file.complete)) ?? false;
    }));
  }
  recordObservation(binding: FileAccessBinding, observation: FileObservation): void { this.recordObservations([{ binding, observation }]); }
  /** Batch commit prevents each scanned file from rewriting the full conversation. */
  recordObservations(items: readonly { binding: FileAccessBinding; observation: FileObservation }[]): void {
    if (!items.length) return;
    const state = this.owner.state(items[0]!.binding.sessionId); this.ready(state); const scope = this.scope(state);
    const next = structuredClone(scope);
    for (const { binding, observation } of items) {
      if (binding.sessionId !== state.session.sessionId || scope.policyVersion !== binding.policyVersion
        || state.active?.runId !== binding.runId) this.stale();
      this.grant(state, binding.grantId, 'read');
      if (observation.grantId !== binding.grantId || observation.rootId !== binding.rootId
        || observation.policyVersion !== binding.policyVersion || observation.path !== binding.path
        || observation.source.sessionId !== binding.sessionId || observation.source.runId !== binding.runId
        || observation.source.turnId !== binding.turnId || observation.source.toolCallId !== binding.toolCallId
        || !sameDestination(observation.destination, binding.destination)) this.stale();
      next.observations.push(structuredClone(observation));
    }
    next.observations = next.observations.slice(-1024);
    assertFileScope(next, state.session.sessionId); state.session.fileScope = next; this.save(state);
  }
  private grant(state: SessionState, id: string, mode: string): FileScopeGrant {
    const grant = this.scope(state).grants.find(g => g.grantId === id);
    if (!grant || grant.revokedAt !== undefined || (grant.expiresAt !== undefined && grant.expiresAt <= this.now())
      || Boolean(grant.device) !== Boolean(this.owner.deviceAccess?.(this.owner.connection(state.session.connectionId)))
      || (mode !== 'read' && mode !== 'write') || (mode === 'write' && grant.mode !== 'read-write')
      || !sameDestination(grant.destination, fileDestination(this.owner.connection(state.session.connectionId)))) {
      throw new FileScopeError('FILE_SCOPE_DENIED', '目录授权已失效、只读或不允许发送到当前模型服务。');
    }
    return grant;
  }
  private checkHostProtection(state: SessionState, path: string): void {
    const protectedPaths = this.owner.deviceAccess?.(this.owner.connection(state.session.connectionId))?.protectedWritePaths ?? [];
    if (protectedPaths.some(root => containsPath(root, path) || containsPath(path, root))) {
      throw new FileScopeError('FILE_SCOPE_DENIED', '应用运行文件、权限配置和会话数据不能由文件工具修改。');
    }
  }
  private scope(state: SessionState) { return state.session.fileScope ?? emptyFileScope(); }
  private ready(state: SessionState) {
    this.owner.requireOpen();
    if (state.saveState.status === 'failed' || state.saveState.status === 'pending') {
      throw new FileScopeError('FILE_SCOPE_SAVE_FAILED', '目录范围尚未保存，重试保存后才能访问。');
    }
  }
  private save(state: SessionState) {
    assertFileScope(this.scope(state), state.session.sessionId);
    if (!this.owner.changed(state)) throw new FileScopeError('FILE_SCOPE_SAVE_FAILED', '目录范围保存失败，未开放访问。');
  }
  private stale(): never { throw new FileScopeError('FILE_SCOPE_STALE', '文件调用绑定已失效。'); }
}
