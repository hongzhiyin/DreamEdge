import { randomUUID } from 'node:crypto';
import { parseModelConnection } from '../model/config.js';
import { thinkingLevels } from '../model/types.js';
import { assertFileHistory } from '../files/file-context.js';
import { launchRun } from './execution.js';
import { configuredTools } from './configured-tools.js';
import { ConversationError, requireText } from './state.js';
import type { SessionState } from './state.js';
import type { ConversationDependencies, ConversationHandle, SendMessageInput, MessageRecord } from './types.js';
import type { SessionPersistence } from './persistence.js';
import type { BatchRecoveryScope } from '../tools/batch-types.js';

/** Validates and deduplicates a user submission before creating its durable run. */
export function submitMessage(state: SessionState, input: SendMessageInput, dependencies: ConversationDependencies,
  now: () => number, persistence: SessionPersistence, recovery?: BatchRecoveryScope): ConversationHandle {
  requireText(input.clientMessageId);
  requireText(input.text);
  if (input.thinkingLevel !== undefined && !thinkingLevels.includes(input.thinkingLevel)) {
    throw new ConversationError('INVALID_COMMAND', '思考强度无效。');
  }
  const previous = state.submissions.get(input.clientMessageId);
  if (previous) {
    if (previous.input.text !== input.text || previous.input.thinkingLevel !== input.thinkingLevel) {
      throw new ConversationError('MESSAGE_CONFLICT', '同一消息标识不能对应不同提问或调用参数。');
    }
    return previous.handle;
  }
  if (state.active) throw new ConversationError('SESSION_BUSY', '当前会话的运行尚未结算。');
  if (state.saveState.status === 'failed') throw new ConversationError('SAVE_FAILED', '请先重试保存。');
  const config = parseModelConnection(dependencies.connection(state.session.connectionId));
  if (config.id !== state.session.connectionId) throw new ConversationError('INVALID_COMMAND', '模型连接标识不一致。');
  if (input.thinkingLevel !== undefined) config.thinkingLevel = input.thinkingLevel;
  assertFileHistory(state.runs, config);
  const tools = state.session.toolsDisabled ? [] : configuredTools(dependencies, config, state.session.sessionId);
  const command: SendMessageInput = { sessionId: input.sessionId,
    clientMessageId: input.clientMessageId, text: input.text,
    ...(input.thinkingLevel === undefined ? {} : { thinkingLevel: input.thinkingLevel }) };
  const question: MessageRecord = { messageId: randomUUID(), sessionId: state.session.sessionId,
    clientMessageId: input.clientMessageId, role: 'user', content: input.text, timestamp: now(),
    ...(input.thinkingLevel === undefined ? {} : { requestedThinkingLevel: input.thinkingLevel }) };
  state.messages.push(question);
  const handle = launchRun(state, question, config, dependencies, now, persistence, false, tools, recovery);
  state.submissions.set(command.clientMessageId, { input: command, handle });
  return handle;
}
