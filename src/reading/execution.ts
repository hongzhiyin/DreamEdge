import { randomUUID } from 'node:crypto';
import type { JsonObject } from '@earendil-works/pi-ai';
import type { ToolExecutionContext, ToolResult } from '../tools/types.js';
import { argumentsDigest, jsonCopy } from '../tools/json.js';
import { NoFileEffectError } from '../files/mutation-types.js';
import type { ReaderService } from './service.js';
import type { ReaderInput, ReaderReply, ReaderRequest } from './protocol.js';
const rejected = new Set(['INVALID_REQUEST', 'INVALID_PARAMS', 'INVALID_SOURCE', 'INVALID_PAGE', 'STALE_CONTEXT', 'NO_SELECTION', 'NO_TEXT',
  'NOT_READY', 'VERSION_CONFLICT', 'MISSING_NOTE', 'MISSING_BOOK', 'UNSUPPORTED_OPERATION', 'REQUEST_CONFLICT']);
const textResult = (data: unknown, committed = false): ToolResult => ({ ...(committed ? { effectState: 'committed' as const } : {}),
  content: [{ type: 'text', text: JSON.stringify(data) }], details: jsonCopy({ readerData: data }) });
export class ReadingExecution {
  constructor(private readonly service: ReaderService) {}
  async read(operation: string, params: JsonObject, ctx: ToolExecutionContext): Promise<unknown> {
    const { binding, session } = await this.service.live(ctx.sessionId, ctx.signal);
    const result = await this.service.client.call(operation, { requestId: randomUUID(), sessionId: session.sessionId,
      bookId: binding.bookId, contextVersion: session.contextVersion, params }, ctx.signal);
    if (!result.ok) throw new NoFileEffectError(`${result.error.code}: ${result.error.message}`, 'TOOL_FAILED');
    return result.data;
  }
  async inspect(name: string, args: JsonObject, ctx: ToolExecutionContext) {
    const { binding } = await this.service.live(ctx.sessionId, ctx.signal);
    if (['reader_note_get', 'reader_note_update'].includes(name) && !this.service.allowedNote(ctx.sessionId, binding, String(args.noteId))) {
      throw new NoFileEffectError('请先在面板明确选择此笔记；只能读取或编辑本对话创建或选择的笔记。');
    }
    if (!['reader_context', 'reader_page', 'reader_notes', 'reader_note_get', 'reader_request_status'].includes(name)
      && this.service.store.requests(ctx.sessionId, binding.bookId).some(r => r.status !== 'complete')) {
      throw new NoFileEffectError('存在未确定的阅读器写入，请先调用 reader_request_status 核对，不能重复创建。');
    }
    return { decision: ['reader_note_create', 'reader_note_update'].includes(name) ? 'ask' as const : 'allow' as const,
      rule: `reading/v1/${name}`, reason: `作用于已绑定书籍《${binding.title}》${name.startsWith('reader_note_') ? '，核对笔记内容与版本。' : '。'}` };
  }
  async execute(name: string, args: JsonObject, ctx: ToolExecutionContext): Promise<ToolResult> {
    await this.inspect(name, args, ctx);
    if (name === 'reader_request_status') return textResult(await this.status(ctx));
    const operations: Record<string, string> = { reader_context: 'context.get', reader_page: 'page.read', reader_navigate: 'reader.navigate',
      reader_locate: 'citation.locate', reader_return: 'reader.return', reader_notes: 'notes.list', reader_note_get: 'notes.get',
      reader_note_create: 'notes.create', reader_note_update: 'notes.update', reader_quote: 'citation.create' };
    const operation = operations[name]; if (!operation) throw new NoFileEffectError('阅读操作未开放。');
    if (['reader_context', 'reader_page', 'reader_notes', 'reader_note_get'].includes(name)) return textResult(await this.read(operation, args, ctx));
    this.service.requireApproval(name, args, ctx);
    const { binding, session } = await this.service.live(ctx.sessionId, ctx.signal);
    let params = args; let version = session.contextVersion;
    if (name === 'reader_quote') {
      const page = await this.read('page.read', { page: args.page! }, ctx) as { rawText: string; page: number; bookId: string; assetHash: string; contextVersion: string };
      const quote = String(args.text); const start = page.rawText.indexOf(quote);
      if (start < 0 || page.rawText.indexOf(quote, start + 1) >= 0) throw new NoFileEffectError('原文不匹配或不唯一，请使用实际读取的更完整选段。');
      version = page.contextVersion; const end = start + quote.length;
      params = { intent: 'quote', source: { bookId: page.bookId, assetHash: page.assetHash, page: page.page, rawText: quote,
        anchor: { version: 1, start, end, prefix: page.rawText.slice(Math.max(0, start - 32), start), suffix: page.rawText.slice(end, end + 32) } } };
    }
    if (name === 'reader_note_create') {
      if (args.kind === 'quote' ? typeof args.citationId !== 'string' || args.page !== undefined
        : args.kind !== 'page' || typeof args.page !== 'number' || args.citationId !== undefined) throw new NoFileEffectError('笔记来源参数不完整或冲突。');
    }
    if (ctx.signal.aborted) throw new NoFileEffectError('阅读器操作已停止，未发送写入。');
    const requestId = `de-${argumentsDigest({ session: ctx.sessionId, run: ctx.runId, call: ctx.toolCallId, operation })}`;
    const input: ReaderInput = { requestId, sessionId: session.sessionId, bookId: binding.bookId, contextVersion: version, params };
    let request: ReaderRequest = { requestId, chatId: ctx.sessionId, bookId: binding.bookId, operation, input, status: 'pending' };
    try { this.service.store.record(request); } catch { throw new NoFileEffectError('请求标识无法保存，未执行阅读器写入。'); }
    let result = await this.service.client.call(operation, input, ctx.signal);
    if (!result.ok && !rejected.has(result.error.code)) {
      const check = await this.query(request, AbortSignal.timeout(8000)); if (check) result = check;
    }
    request = { ...request, status: result.ok || rejected.has(result.error.code) ? 'complete' : 'uncertain', result };
    try { this.service.store.record(request); } catch { /* Confirmed remote success still has a truthful SQLite tool result. */ }
    if (result.ok) return textResult(result.data, true);
    if (rejected.has(result.error.code)) throw new NoFileEffectError(`${result.error.code}: ${result.error.message}`, 'TOOL_FAILED');
    throw new Error('阅读器写入结果未知；请使用 reader_request_status 查询原请求。');
  }
  private async query(record: ReaderRequest, signal: AbortSignal): Promise<ReaderReply | undefined> {
    const result = await this.service.client.call('requests.get', { requestId: randomUUID(), sessionId: record.input.sessionId!,
      bookId: record.bookId, params: { targetRequestId: record.requestId } }, signal);
    if (!result.ok) return;
    const data = result.data as { status?: string; result?: ReaderReply }; return data.status === 'complete' ? data.result : undefined;
  }
  private async status(ctx: ToolExecutionContext) {
    const binding = this.service.binding(ctx.sessionId);
    const pending = this.service.store.requests(ctx.sessionId, binding.bookId).filter(r => r.status !== 'complete').slice(0, 8);
    const results: unknown[] = [];
    for (const request of pending) {
      const result = await this.query(request, ctx.signal);
      if (result) this.service.store.record({ ...request, status: 'complete', result });
      results.push({ requestId: request.requestId, operation: request.operation, status: result ? 'complete' : 'uncertain', ...(result ? { result } : {}) });
    }
    return results;
  }
}
