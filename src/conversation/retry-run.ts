import { assertFileHistory } from '../files/file-context.js';
import { launchRun } from './execution.js';
import { retryTools } from './configured-tools.js';
import { ConversationError } from './state.js';
import type { SessionState } from './state.js';
import type { ConversationDependencies, ConversationHandle } from './types.js';
import type { SessionPersistence } from './persistence.js';

export function retryRun(state: SessionState, dependencies: ConversationDependencies, now: () => number,
  persistence: SessionPersistence, expectedRunId?: string, mode: 'continue' | 'read_tools' = 'continue'): ConversationHandle {
  const question = state.messages.at(-1);
  const attempt = state.runs.at(-1);
  if (expectedRunId !== undefined && attempt?.runId !== expectedRunId) {
    throw new ConversationError('STALE_RUN', '回复状态已更新，请使用当前回复的操作。');
  }
  if (!question || !attempt || attempt.userMessageId !== question.messageId
    || !['failed', 'cancelled', 'interrupted'].includes(attempt.status)) {
    throw new ConversationError('RETRY_UNAVAILABLE', '只能重试最近一次失败、取消或中断的提问。');
  }
  if (!['continue', 'read_tools'].includes(mode)) throw new ConversationError('INVALID_COMMAND', '重试方式无效。');
  if (state.runs.some(run => run.userMessageId === question.messageId
    && run.toolCalls?.some(call => call.status === 'outcome_unknown'))) {
    throw new ConversationError('RETRY_UNAVAILABLE', '写操作结果未知；核对实际结果后发起新提问，不能直接重试。');
  }
  assertFileHistory(state.runs, dependencies.connection(state.session.connectionId));
  const tools = state.session.toolsDisabled || mode === 'continue' ? [] : retryTools(dependencies, attempt.modelConfigSnapshot,
    attempt.toolsSnapshot ?? [], state.session.sessionId).filter(tool => tool.effect === 'read' && tool.approval === 'never');
  return launchRun(state, question, attempt.modelConfigSnapshot, dependencies, now, persistence, true, tools);
}
