import type { ConversationHandle, MessageRecord, RunRecord, SendMessageInput, SessionRecord } from './types.js';
import type { SaveState } from '../storage/types.js';

export interface SessionState {
  session: SessionRecord;
  messages: MessageRecord[];
  runs: RunRecord[];
  submissions: Map<string, { input: SendMessageInput; handle: ConversationHandle }>;
  active?: ConversationHandle;
  saveState: SaveState;
  notify(): void;
}

export function touch(state: SessionState, now: () => number): void {
  state.session.version++;
  state.session.updatedAt = now();
  state.notify();
}

export class ConversationError extends Error {
  constructor(
    readonly code: 'INVALID_COMMAND' | 'SESSION_NOT_FOUND' | 'SESSION_BUSY'
      | 'FILE_CONTEXT_DESTINATION' | 'MESSAGE_CONFLICT' | 'RETRY_UNAVAILABLE' | 'SERVICE_CLOSED' | 'SAVE_FAILED' | 'STALE_RUN',
    message: string,
  ) { super(message); this.name = 'ConversationError'; }
}

export function requireText(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ConversationError('INVALID_COMMAND', '会话标识、连接标识和提问内容必须为非空文字。');
  }
}
