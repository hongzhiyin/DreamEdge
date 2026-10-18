import type { Message } from '@earendil-works/pi-ai';
import type { MessageRecord } from './types.js';
import type { SessionState } from './state.js';
import { questionHistory } from './tool-history.js';

/** Only completed turns and the current question enter the model context. */
export function conversationContext(state: SessionState, current: MessageRecord, resume = false): Message[] {
  const context: Message[] = [];
  if (state.session.systemPrompt) {
    context.push({ role: 'system', content: state.session.systemPrompt, timestamp: state.session.createdAt });
  }
  for (const question of state.messages) {
    const user: Message = { role: 'user', content: question.content, timestamp: question.timestamp };
    const attempts = state.runs.filter(run => run.userMessageId === question.messageId);
    if (question.messageId === current.messageId) {
      context.push(user);
      if (resume) context.push(...questionHistory(attempts, false));
      break;
    }
    const history = questionHistory(attempts);
    if (history.length) context.push(user, ...history);
  }
  return structuredClone(context);
}
