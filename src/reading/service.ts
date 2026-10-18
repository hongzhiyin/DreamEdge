import { randomUUID } from 'node:crypto';
import type { ModelConnectionConfig } from '../model/types.js';
import type { ConversationSnapshot } from '../conversation/types.js';
import { fileDestination } from '../files/scope-types.js';
import { sameDestination } from '../files/scope-validation.js';
import { ModelAdapterError } from '../model/errors.js';
import { NoFileEffectError } from '../files/mutation-types.js';
import type { ReaderClient, ReaderSession, ReaderBinding } from './protocol.js';
import { ReaderStore } from './store.js';
import { readerVersion } from './protocol.js';
import type { ToolExecutionContext } from '../tools/types.js';
import type { JsonObject } from '@earendil-works/pi-ai';
import { argumentsDigest } from '../tools/json.js';

export class ReaderService {
  constructor(readonly client: ReaderClient, readonly store: ReaderStore,
    private readonly chat: (id: string) => ConversationSnapshot, private readonly connection: () => ModelConnectionConfig) {}
  enabled(id: string): boolean {
    const binding = this.store.binding(id);
    return Boolean(binding && sameDestination(binding.destination, fileDestination(this.connection())));
  }
  binding(id: string): ReaderBinding {
    this.chat(id); const binding = this.store.binding(id);
    if (!binding || !this.enabled(id)) throw new NoFileEffectError('请先在阅读器面板明确绑定窗口和书籍；模型服务变化后需重新绑定。');
    return binding;
  }
  async sessions(signal: AbortSignal): Promise<ReaderSession[]> {
    const result = await this.client.call('sessions.list', { requestId: randomUUID(), params: {} }, signal);
    if (!result.ok || !Array.isArray(result.data)) throw new NoFileEffectError(result.ok ? '阅读器会话列表无效。' : result.error.message);
    return result.data.filter((s): s is ReaderSession => s && typeof s.sessionId === 'string' && typeof s.bookId === 'string'
      && typeof s.contextVersion === 'string' && typeof s.title === 'string' && s.ready === true);
  }
  async live(id: string, signal: AbortSignal) {
    const binding = this.binding(id);
    const session = (await this.sessions(signal)).find(s => s.sessionId === binding.readerSessionId && s.bookId === binding.bookId);
    if (!session) throw new NoFileEffectError('绑定的阅读窗口已离线、书籍已变化或未准备好，请重新选择。');
    return { binding, session };
  }
  guardHistory(id: string, config: ModelConnectionConfig): void {
    const destination = fileDestination(config);
    if (this.chat(id).runs.some(run => run.toolCalls?.some(call => call.toolVersion === readerVersion && call.status === 'succeeded')
      && !sameDestination(fileDestination(run.modelConfigSnapshot), destination))) {
      throw new ModelAdapterError('INVALID_CONTEXT', '历史阅读内容只授权原模型服务；请恢复原连接或新建对话。');
    }
  }
  allowedNote(chatId: string, binding: ReaderBinding, noteId: string): boolean {
    if (binding.selectedNotes.includes(noteId)) return true;
    return this.store.requests(chatId, binding.bookId).some(r => r.operation === 'notes.create' && r.result?.ok
      && (r.result.data as { note?: { id?: string } })?.note?.id === noteId);
  }
  requireApproval(name: string, args: JsonObject, ctx: ToolExecutionContext): void {
    const state = this.chat(ctx.sessionId); const run = state.runs.find(r => r.runId === ctx.runId);
    const call = run?.toolCalls?.find(c => c.toolCallId === ctx.toolCallId);
    const receipt = run?.approvals?.find(a => a.approvalId === ctx.approval?.approvalId);
    if (state.activeRunId !== ctx.runId || call?.status !== 'running' || call.turnId !== ctx.turnId
      || call.toolName !== name || call.argsDigest !== argumentsDigest(args) || receipt?.status !== 'approved'
      || receipt.toolCallId !== call.toolCallId || receipt.expiresAt <= Date.now()) {
      throw new NoFileEffectError('阅读器写入没有有效的宿主批准记录。');
    }
  }
  async ui(value: unknown) {
    const c = value as Record<string, unknown>;
    if (!c || typeof c !== 'object' || Array.isArray(c) || typeof c.type !== 'string'
      || Object.keys(c).some(k => !['type', 'chatId', 'readerSessionId', 'bookId', 'noteId'].includes(k))) throw new Error('阅读器命令无效。');
    const signal = AbortSignal.timeout(25_000);
    if (c.type === 'list') return this.sessions(signal);
    if (typeof c.chatId !== 'string') throw new Error('缺少对话标识。');
    const state = this.chat(c.chatId);
    if (c.type === 'status') return { binding: this.store.binding(c.chatId) ?? null, enabled: this.enabled(c.chatId) };
    const editable = () => { const current = this.chat(c.chatId as string);
      if (!current.acceptingCommands || current.activeRunId || current.saveState.status !== 'saved') throw new Error('请先停止当前运行并完成保存，再更改阅读绑定。'); };
    editable();
    if (c.type === 'unbind') { this.store.bind(c.chatId); return { binding: null, enabled: false }; }
    if (c.type === 'bind') {
      const session = (await this.sessions(signal)).find(s => s.sessionId === c.readerSessionId && s.bookId === c.bookId);
      if (!session) throw new Error('指定阅读窗口或书籍已变化。');
      editable();
      const binding: ReaderBinding = { readerSessionId: session.sessionId, bookId: session.bookId, title: session.title,
        destination: fileDestination(this.connection()), selectedNotes: [] };
      this.store.bind(c.chatId, binding); return { binding, enabled: true };
    }
    const { binding, session } = await this.live(c.chatId, signal);
    if (c.type === 'notes' || c.type === 'selectNote') {
      const result = await this.client.call(c.type === 'notes' ? 'notes.list' : 'notes.get', { requestId: randomUUID(),
        sessionId: session.sessionId, bookId: binding.bookId, params: c.type === 'notes' ? {} : { noteId: String(c.noteId) } }, signal);
      if (!result.ok) throw new Error(result.error.message);
      if (c.type === 'notes') return result.data;
      const note = result.data as { id?: string; bookId?: string };
      if (note.id !== c.noteId || note.bookId !== binding.bookId) throw new Error('笔记不属于绑定书籍。');
      editable();
      const current = this.binding(c.chatId);
      if (current.readerSessionId !== binding.readerSessionId || current.bookId !== binding.bookId) throw new Error('阅读绑定已变化，请重新选择笔记。');
      binding.selectedNotes = [...new Set([...binding.selectedNotes, note.id!])]; this.store.bind(c.chatId, binding);
      return { binding, enabled: true };
    }
    throw new Error('阅读器命令未开放。');
  }
}
