import type { MessageRecord, RunRecord, SessionRecord } from '../conversation/types.js';

export interface StoredConversation {
  session: SessionRecord;
  messages: MessageRecord[];
  runs: RunRecord[];
}

/** Commits a complete session projection atomically, with optimistic version checks. */
export interface SessionStore {
  load(): StoredConversation[];
  save(snapshot: StoredConversation, expectedVersion: number | null): void;
  close(): void;
}

export interface SaveState {
  status: 'disabled' | 'saved' | 'pending' | 'failed';
  savedVersion: number | null;
  error?: { code: 'SAVE_FAILED'; message: string };
}

export class SessionStoreError extends Error {
  constructor(
    readonly code: 'OPEN_FAILED' | 'READ_FAILED' | 'WRITE_FAILED' | 'INVALID_DATA' | 'MIGRATION_FAILED'
      | 'VERSION_CONFLICT' | 'UNSUPPORTED_SCHEMA' | 'STORE_CLOSED',
    message: string,
  ) { super(message); this.name = 'SessionStoreError'; }
}
