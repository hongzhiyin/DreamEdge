import { submitMessage } from './submission.js';
import { batchRecovery } from './batch-recovery.js';
import type { ResumeBatchCommand } from '../tools/batch-types.js';
import { FileScopeService } from '../files/scope-service.js';
import { touch } from './state.js';
import { retryRun } from './retry-run.js';
import { randomUUID } from 'node:crypto';
import { parseModelConnection } from '../model/config.js';
import { ChangeFeed } from './change-feed.js';
import { SessionPersistence } from './persistence.js';
import { restoreSession } from './recovery.js';
import type { ApprovalDecisionCommand } from '../runtime/tool-contracts.js';
import type { SaveState } from '../storage/types.js';
import { ConversationError, requireText } from './state.js';
import type { SessionState } from './state.js';
import type {
  ConversationDependencies, ConversationHandle, ConversationSnapshot, CreateSessionInput,
  SendMessageInput, SessionRecord,
} from './types.js';

/** Owns session projections and coordinates their durable lifecycle. */
export class ConversationService {
  private readonly sessions = new Map<string, SessionState>();
  private readonly now: () => number;
  private closed = false;
  private disposal: Promise<void> | undefined;
  private readonly persistence: SessionPersistence;
  private readonly changes = new ChangeFeed();
  readonly fileScopes: FileScopeService;

  constructor(private readonly dependencies: ConversationDependencies) {
    this.now = dependencies.now ?? Date.now;
    this.persistence = new SessionPersistence(dependencies.store, dependencies.checkpointMs);
    this.fileScopes = new FileScopeService({ state: id => this.state(id), connection: id => this.connection(id),
      ...(dependencies.deviceAccess ? { deviceAccess: dependencies.deviceAccess } : {}),
      requireOpen: () => this.requireOpen(), changed: state => { touch(state, this.now); return this.persistence.flush(state); } },
    this.now, dependencies.directoryPicker);
    for (const snapshot of dependencies.store?.load() ?? []) {
      const state = restoreSession(snapshot, this.now, () => this.notify(snapshot.session.sessionId));
      this.sessions.set(state.session.sessionId, state);
      this.persistence.flush(state);
      this.fileScopes.syncDeviceAccess(state.session.sessionId);
    }
  }

  createSession(input: CreateSessionInput): SessionRecord {
    this.requireOpen();
    requireText(input.connectionId);
    if (input.title !== undefined) requireText(input.title);
    if (input.systemPrompt !== undefined && typeof input.systemPrompt !== 'string') {
      throw new ConversationError('INVALID_COMMAND', '系统提示必须为文字。');
    }
    if (input.externalTools !== undefined && (input.externalTools !== true || input.toolsDisabled)) throw new ConversationError('INVALID_COMMAND', '外部工具策略无效。');
    if (input.toolsDisabled !== undefined && input.toolsDisabled !== true) throw new ConversationError('INVALID_COMMAND', '工具策略无效。');
    this.connection(input.connectionId);
    const timestamp = this.now();
    const session: SessionRecord = { sessionId: randomUUID(), connectionId: input.connectionId,
      title: input.title ?? '新对话', createdAt: timestamp, updatedAt: timestamp, version: 0,
      ...(input.externalTools ? { externalTools: true as const } : {}),
      ...(input.toolsDisabled ? { toolsDisabled: true as const } : {}),
      ...(input.systemPrompt === undefined ? {} : { systemPrompt: input.systemPrompt }) };
    const state: SessionState = { session, messages: [], runs: [], submissions: new Map(),
      notify: () => this.notify(session.sessionId),
      saveState: { status: this.dependencies.store ? 'pending' : 'disabled', savedVersion: null } };
    this.sessions.set(session.sessionId, state);
    this.persistence.flush(state);
    this.fileScopes.syncDeviceAccess(session.sessionId);
    state.notify();
    return structuredClone(session);
  }

  listSessions(): SessionRecord[] {
    return structuredClone([...this.sessions.values()].map(state => state.session));
  }
  refreshDeviceAccess(strict = true): void {
    for (const state of this.sessions.values()) this.fileScopes.syncDeviceAccess(state.session.sessionId, strict);
  }

  subscribe(listener: (sessionId: string) => void): () => void {
    return this.changes.subscribe(listener);
  }

  getSnapshot(sessionId: string): ConversationSnapshot {
    const state = this.state(sessionId);
    return structuredClone({ session: state.session, messages: state.messages, runs: state.runs, saveState: state.saveState,
      acceptingCommands: !this.closed,
      ...(state.active ? { activeRunId: state.active.runId } : {}) });
  }

  send(input: SendMessageInput): ConversationHandle {
    this.requireOpen();
    return submitMessage(this.state(input.sessionId), input, this.dependencies, this.now, this.persistence);
  }

  resumeBatch(command: ResumeBatchCommand): ConversationHandle {
    this.requireOpen(); const state = this.state(command.sessionId); this.requireIdle(state);
    const scope = batchRecovery(state.runs, command);
    return submitMessage(state, { sessionId: command.sessionId, clientMessageId: randomUUID(),
      text: `恢复批量计划中尚未完成的 ${scope.items.length} 项操作，重新核对差异并确认。` },
      this.dependencies, this.now, this.persistence, scope);
  }

  retry(sessionId: string, expectedRunId?: string, mode: 'continue' | 'read_tools' = 'continue'): ConversationHandle {
    this.requireOpen();
    const state = this.state(sessionId);
    this.requireIdle(state);
    return retryRun(state, this.dependencies, this.now, this.persistence, expectedRunId, mode);
  }

  stop(sessionId: string, expectedRunId?: string): void {
    const active = this.state(sessionId).active;
    if (expectedRunId !== undefined && active?.runId !== expectedRunId) {
      throw new ConversationError('STALE_RUN', '该回复已经结束，停止请求未影响其他回复。');
    }
    active?.cancel();
  }

  decideApproval(command: ApprovalDecisionCommand): void {
    this.requireOpen();
    const state = this.state(command.sessionId);
    if (state.saveState.status === 'failed') throw new ConversationError('SAVE_FAILED', '保存失败，重试保存后才能处理授权。');
    if (state.active?.runId !== command.runId || !state.active.decideApproval?.(command)) {
      throw new ConversationError('STALE_RUN', '授权已失效或不属于当前工具调用。');
    }
  }

  retrySave(sessionId: string): SaveState {
    const state = this.state(sessionId);
    this.persistence.flush(state, true);
    this.fileScopes.syncDeviceAccess(sessionId);
    return structuredClone(state.saveState);
  }

  dispose(): Promise<void> {
    if (!this.disposal) {
      this.closed = true;
      for (const id of this.sessions.keys()) this.notify(id);
      const handles = [...this.sessions.values()].flatMap(state => state.active ? [state.active] : []);
      for (const handle of handles) handle.cancel();
      this.disposal = Promise.all(handles.map(handle => handle.done))
        .then(() => { this.persistence.close(this.sessions.values()); this.changes.clear(); })
        .catch(error => {
          this.disposal = undefined; this.closed = false;
          for (const id of this.sessions.keys()) this.notify(id);
          throw error;
        });
    }
    return this.disposal;
  }

  private connection(id: string) {
    const config = parseModelConnection(this.dependencies.connection(id));
    if (config.id !== id) throw new ConversationError('INVALID_COMMAND', '模型连接标识不一致。');
    return config;
  }

  private state(id: string): SessionState {
    requireText(id);
    const state = this.sessions.get(id);
    if (!state) throw new ConversationError('SESSION_NOT_FOUND', '会话不存在。');
    return state;
  }

  private requireIdle(state: SessionState): void {
    if (state.active) throw new ConversationError('SESSION_BUSY', '当前会话的运行尚未结算。');
    if (state.saveState.status === 'failed') {
      throw new ConversationError('SAVE_FAILED', '会话存在未保存内容；重试保存后才能继续。');
    }
  }

  private requireOpen(): void {
    if (this.closed) throw new ConversationError('SERVICE_CLOSED', '会话服务已关闭。');
  }

  private notify(sessionId: string): void {
    this.changes.notify(sessionId);
  }
}
