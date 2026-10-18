import { ConversationError } from '../conversation/state.js';
import type { ConversationService } from '../conversation/service.js';
import type { ModelConnectionConfig } from '../model/types.js';
import { ChatJournal } from './journal.js';
import { chatView } from './projection.js';
import { chatCommand } from './validation.js';
import type { ChatCommand, ChatConnection, ChatEvent, ChatReply, ChatSession } from './types.js';

export class ChatHub {
  private readonly journals = new Map<string, ChatJournal>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly listeners = new Set<(event: ChatEvent) => void>();
  private readonly unsubscribe: () => void;
  private readonly connection: ChatConnection;

  constructor(private readonly service: ConversationService, private readonly config: ModelConnectionConfig,
    private readonly replayLimit = 32, private readonly intervalMs = 32) {
    this.connection = { model: config.model,
      levels: [...(config.reasoning?.supportedLevels ?? ['off'])],
      defaultLevel: config.thinkingLevel ?? (config.reasoning ? 'high' : 'off') };
    this.unsubscribe = service.subscribe(id => this.schedule(id));
  }

  execute(value: unknown): ChatReply<unknown> {
    try { return { ok: true, data: this.route(chatCommand(value)) }; }
    catch (error) {
      return { ok: false, error: error instanceof ConversationError
        ? { code: error.code, message: error.message }
        : { code: 'CHAT_FAILED', message: '无法完成聊天操作，请稍后重试。' } };
    }
  }

  subscribe(listener: (event: ChatEvent) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  dispose(): void {
    this.unsubscribe();
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear(); this.listeners.clear(); this.journals.clear();
  }

  private route(command: ChatCommand): unknown {
    if (command.type === 'initialize') return { sessions: this.list(), connection: structuredClone(this.connection) };
    if (command.type === 'create') {
      const session = this.service.createSession({ connectionId: this.config.id });
      return this.summary(session.sessionId);
    }
    if (command.type === 'watch') return this.publish(command.sessionId).catchup(command.cursor);
    if (command.type === 'send') {
      const { runId, userMessageId } = this.service.send(command.input);
      return { runId, userMessageId };
    }
    if (command.type === 'resumeBatch') {
      const { runId, userMessageId } = this.service.resumeBatch(command.reference); return { runId, userMessageId };
    }
    if (command.type === 'stop') { this.service.stop(command.sessionId, command.runId); return; }
    if (command.type === 'approval') { this.service.decideApproval(command.decision); return; }
    if (command.type === 'retrySave') { this.service.retrySave(command.sessionId); return; }
    if (command.type === 'retry') {
      const { runId, userMessageId } = this.service.retry(command.sessionId, command.runId, command.mode);
      return { runId, userMessageId };
    }
  }

  private list(): ChatSession[] {
    return this.service.listSessions().map(session => this.summary(session.sessionId))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  private summary(id: string): ChatSession {
    const view = this.view(id);
    return { sessionId: id, title: view.title, updatedAt: view.updatedAt };
  }

  private schedule(id: string): void {
    if (this.timers.has(id)) return;
    const timer = setTimeout(() => { this.publish(id); }, this.intervalMs);
    this.timers.set(id, timer);
  }

  private publish(id: string): ChatJournal {
    clearTimeout(this.timers.get(id)); this.timers.delete(id);
    const journal = this.journals.get(id) ?? new ChatJournal(this.replayLimit);
    this.journals.set(id, journal);
    const event = journal.publish(this.view(id));
    if (event) for (const listener of this.listeners) {
      try { listener(structuredClone(event)); } catch { /* Disconnected windows do not interrupt the host. */ }
    }
    return journal;
  }
  private view(id: string) { return chatView(this.service.getSnapshot(id), this.service.fileScopes.overview(id)); }
}
