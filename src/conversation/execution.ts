import { ModelAdapterError } from '../model/errors.js';
import { guardExternalHistory } from './external-history.js';
import { prepareRunTools } from './prepared-tools.js';
import { guardFileContext } from '../files/file-context.js';
import { fileDestination } from '../files/scope-types.js';
import { sameDestination } from '../files/scope-validation.js';
import { randomUUID } from 'node:crypto';
import { prepareContext } from '../model/context.js';
import { thinkingLevels } from '../model/types.js';
import type { ModelConnectionConfig, RuntimeEvent, RuntimeFailure, RuntimeHandle, RuntimeResult } from '../model/types.js';
import { conversationContext } from './context.js';
import { touch } from './state.js';
import type { SessionState } from './state.js';
import type { SessionPersistence } from './persistence.js';
import type { ConversationDependencies, ConversationHandle, MessageRecord, RunRecord } from './types.js';
import type { ToolSnapshot } from '../tools/types.js';
import { toolCheckpoint } from './tool-checkpoint.js';

export function launchRun(
  state: SessionState, question: MessageRecord, config: ModelConnectionConfig,
  dependencies: ConversationDependencies, now: () => number,
  persistence: SessionPersistence,
  resume = false,
  tools: readonly ToolSnapshot[] = [],
  recovery?: import('../tools/batch-types.js').BatchRecoveryScope,
): ConversationHandle {
  if (state.session.toolsDisabled) tools = [];
  const record: RunRecord = {
    sessionId: state.session.sessionId, userMessageId: question.messageId, runId: randomUUID(),
    modelConfigSnapshot: structuredClone(config), status: 'running', text: '', thinking: '',
    ...(recovery ? { batchRecovery: structuredClone(recovery.reference) } : {}),
    notices: [], lastEventSequence: 0, createdAt: now(),
    ...(!dependencies.prepareTools || resume ? tools.length ? { toolsSnapshot: structuredClone(tools), transcript: [], toolCalls: [], approvals: [],
      thinkingLevel: config.thinkingLevel ?? (config.reasoning ? 'high' : 'off') } : {} : {}),
  };
  const messages = conversationContext(state, question, resume);
  const roots = state.session.fileScope?.grants.filter(g => g.revokedAt === undefined && (g.expiresAt === undefined || g.expiresAt > now())
    && Boolean(g.device) === Boolean(dependencies.deviceAccess?.(config))
    && sameDestination(g.destination, fileDestination(config))) ?? [];
  const account = dependencies.deviceAccess?.(config)?.mode === 'account';
  if (roots.length && tools.some(tool => tool.resources.includes('filesystem'))) messages.unshift({ role: 'system', timestamp: now(), content: roots.some(g => g.device)
    ? `${account ? '账户权限访问' : '整机文件访问'}已启用，根范围：${JSON.stringify(roots.map(g => g.path))}。相对路径及 ~/ 基于 ${roots[0]!.device!.baseDirectory}；可以使用绝对路径访问系统账户权限允许的普通文件，无需选择目录。路径由宿主规范化；.ssh、.codex、.env、凭据和默认排除项不可访问。搜索有预算限制，应先列表定位再搜索具体目录。${account ? '普通新建与局部编辑由执行前检查自动放行；覆盖、清空、大范围编辑与系统配置修改由宿主请求确认，不另行用文字要求用户先授权普通操作。' : 'write/edit 始终逐次预览和批准。'}已有文件先读取当前版本，覆盖需完整读取。批量修改先读取全部目标，再在同一回复中连续提出 文件变更调用；不同文件可以一次确认，同一路径的依赖修改分开处理。delete 默认移到废纸篓，permanent=true 为永久删除，两种删除均需确认。copy/move 不覆盖目标，mkdir 仅创建单层目录。没有 shell 或任意代码执行工具。`
    : `会话文件工具目录：${JSON.stringify(roots.map(g => ({ path: g.path, mode: g.mode })))}。多个目录必须使用绝对路径。写入需要逐次预览和批准；已有文件需先读取当前版本，覆盖需完整读取。未授权项目和链接不可访问，没有 shell 工具。` });
  const request = { sessionId: record.sessionId, runId: record.runId, messages, beforeModelRequest: (outgoing: readonly import('@earendil-works/pi-ai').Message[], signal: AbortSignal) => {
      signal.throwIfAborted(); guardFileContext(state.runs, config, dependencies.connection(state.session.connectionId), outgoing);
      guardExternalHistory(state.runs, config, dependencies.connection(state.session.connectionId), dependencies.prepareTools);
      dependencies.guardModelContext?.(state.session.sessionId, config);
    },
    ...(messages.at(-1)?.role === 'toolResult' ? { continuation: true } : {}) };
  if (recovery) messages.unshift({ role: 'system', timestamp: now(), content:
    `本次恢复仅允许以下未完成变更；已完成项不得重做。先读取当前版本，再在同一回复中请求所有剩余变更，参数保持一致。每项都需重新检查与确认：${JSON.stringify(recovery.items.map(({ toolName, args, path }) => ({ toolName, args, path })))}` });
  const toolRequest = (selected: readonly ToolSnapshot[]) => selected.length ? { ...(recovery ? { batchRecovery: structuredClone(recovery) } : {}), tools: structuredClone(selected), approvalsEnabled: Boolean(dependencies.store),
    checkpoint: toolCheckpoint(state, record, persistence, now) } : {};
  let runtime: RuntimeHandle | undefined;
  let cancellationRequested = false;
  let controlFailure: RuntimeFailure | undefined;
  const preflight = new AbortController();
  const cancel = () => {
    if (state.active?.runId !== record.runId || record.status !== 'running') return;
    record.status = 'cancelling';
    cancellationRequested = true;
    touch(state, now);
    try { runtime?.cancel(); }
    catch { controlFailure ??= { code: 'REQUEST_FAILED', message: '运行时未能正常接收停止请求。' }; }
    preflight.abort();
    persistence.flush(state);
  };
  const receive = (event: RuntimeEvent) => {
    if (state.active?.runId !== record.runId) return;
    const fail = () => {
      controlFailure = { code: 'UNEXPECTED_RESPONSE', message: '运行事件格式或序号异常，回复未被作为完整历史使用。' };
      cancel();
    };
    if (!event || typeof event !== 'object') { fail(); return; }
    if (event.sessionId !== record.sessionId || event.runId !== record.runId) return;
    if (event.sequence <= record.lastEventSequence) return;
    if (!Number.isSafeInteger(event.sequence) || event.sequence !== record.lastEventSequence + 1
      || !validEvent(event)) { fail(); return; }
    record.lastEventSequence = event.sequence;
    if (event.type === 'started') {
      record.thinkingLevel = event.thinkingLevel;
      record.notices = [...event.notices];
    } else if (event.type === 'delta' && record.status === 'running') {
      record[event.channel] += event.delta;
    } else if (event.type === 'message_started' && record.status === 'running') {
      record.text = ''; record.thinking = '';
      record.currentMessageId = event.messageId; record.currentTurnId = event.turnId;
    }
    touch(state, now);
    persistence.changed(state);
  };
  const done = Promise.resolve().then(async () => {
    try {
      let ready = true;
      if (!cancellationRequested && !persistence.canStart(state)) {
        ready = await persistence.waitForSave(state, preflight.signal);
      }
      if (cancellationRequested || !ready) record.status = 'cancelled';
      else {
        guardExternalHistory(state.runs, config, dependencies.connection(state.session.connectionId), dependencies.prepareTools);
        const prepared = !state.session.toolsDisabled && !resume && dependencies.prepareTools
          ? await prepareRunTools(state, record, dependencies, persistence, tools, preflight.signal, now) : undefined;
        preflight.signal.throwIfAborted();
        const adapter = prepared?.runtime ?? dependencies.runtime(structuredClone(config));
        runtime = adapter.start({ ...request, ...toolRequest(prepared?.tools ?? tools) }, receive);
        if (cancellationRequested) {
          try { runtime.cancel(); }
          catch { controlFailure ??= { code: 'REQUEST_FAILED', message: '运行时未能正常接收停止请求。' }; }
        }
        settleRecord(record, await runtime.done);
      }
    } catch (error) {
      record.status = cancellationRequested ? 'cancelled' : 'failed';
      if (!cancellationRequested) record.error = error instanceof ModelAdapterError
        ? { code: error.code, message: error.message } : { code: 'REQUEST_FAILED', message: '会话运行无法正常结算。' };
    } finally {
      if (controlFailure) { record.status = 'failed'; record.error = controlFailure; }
      record.finishedAt = now();
      if (state.active?.runId === record.runId) delete state.active;
      touch(state, now);
      persistence.flush(state);
    }
    return structuredClone(record);
  });
  const handle = Object.freeze({ sessionId: record.sessionId, userMessageId: question.messageId,
    runId: record.runId, cancel, done, decideApproval: (command: import('../runtime/tool-contracts.js').ApprovalDecisionCommand) =>
      state.active?.runId === record.runId && record.status === 'running' && (runtime?.decideApproval?.(command) ?? false) });
  state.runs.push(record);
  state.active = handle;
  touch(state, now);
  persistence.flush(state);
  return handle;
}

function settleRecord(record: RunRecord, result: RuntimeResult): void {
  if (!result || result.sessionId !== record.sessionId || result.runId !== record.runId
    || !['completed', 'cancelled', 'failed'].includes(result.status) || typeof result.text !== 'string'
    || (result.error && (typeof result.error.code !== 'string' || typeof result.error.message !== 'string'))) {
    throw new Error('Runtime result identity mismatch');
  }
  if (result.status === 'completed') {
    if (!result.message || result.message.stopReason !== 'stop') throw new Error('Incomplete history');
    prepareContext({ sessionId: record.sessionId, runId: record.runId, messages: [
      result.message, { role: 'user', content: 'validate', timestamp: 0 },
    ] });
  }
  const native = result.message ? structuredClone(result.message) : undefined;
  if (result.toolData) Object.assign(record, structuredClone(result.toolData));
  const thinking = native?.content.filter(block => block.type === 'thinking').map(block => block.thinking).join('');
  record.status = result.status; record.text = result.text;
  if (result.message) {
    record.nativeMessage = native!; record.thinking = thinking!;
  }
  if (result.stopReason) record.stopReason = result.stopReason;
  if (result.thinkingLevel) record.thinkingLevel = result.thinkingLevel;
  if (result.error) record.error = structuredClone(result.error);
}

function validEvent(event: RuntimeEvent): boolean {
  if (event.type === 'message_started') return event.role === 'assistant'
    && typeof event.turnId === 'string' && typeof event.messageId === 'string';
  if (event.type === 'delta') return ['text', 'thinking'].includes(event.channel) && typeof event.delta === 'string';
  if (event.type === 'started') return typeof event.model === 'string' && typeof event.connectionId === 'string'
    && thinkingLevels.includes(event.thinkingLevel) && Array.isArray(event.notices)
    && event.notices.every(notice => typeof notice === 'string');
  return event.type === 'settled' && Boolean(event.result) && event.result.sessionId === event.sessionId
    && event.result.runId === event.runId;
}
