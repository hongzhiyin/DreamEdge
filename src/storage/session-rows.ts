import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import { SessionStoreError } from './types.js';
import type { StoredConversation } from './types.js';
import { loadToolRows } from './tool-rows.js';

export function parseRow(row: Record<string, SQLOutputValue>): unknown {
  if (typeof row.record !== 'string') throw new SessionStoreError('INVALID_DATA', '会话数据库记录无效。');
  return JSON.parse(row.record);
}

export function readConversations(db: DatabaseSync, tools = true): StoredConversation[] {
  const invalid = (): never => { throw new SessionStoreError('INVALID_DATA', '会话记录归属或顺序无效。'); };
  const snapshots = new Map<string, StoredConversation>();
  for (const row of db.prepare('SELECT * FROM sessions ORDER BY rowid').all()) {
    const session = parseRow(row) as StoredConversation['session'];
    if (session.sessionId !== row.session_id || session.version !== row.version) invalid();
    snapshots.set(session.sessionId, { session, messages: [], runs: [] });
  }
  for (const row of db.prepare('SELECT * FROM messages ORDER BY ordinal').all()) {
    const message = parseRow(row) as StoredConversation['messages'][number];
    const state = snapshots.get(message.sessionId);
    if (!state || message.messageId !== row.message_id || message.sessionId !== row.session_id
      || message.clientMessageId !== row.client_message_id || row.ordinal !== state.messages.length) return invalid();
    state.messages.push(message);
  }
  const runs = new Map<string, StoredConversation['runs'][number]>();
  for (const row of db.prepare('SELECT * FROM runs ORDER BY ordinal').all()) {
    const run = parseRow(row) as StoredConversation['runs'][number];
    const state = snapshots.get(run.sessionId);
    if (!state || run.runId !== row.run_id || run.sessionId !== row.session_id
      || run.userMessageId !== row.user_message_id || run.status !== row.status || row.ordinal !== state.runs.length) return invalid();
    state.runs.push(run); runs.set(run.runId, run);
  }
  if (tools) loadToolRows(db, runs);
  return [...snapshots.values()];
}
