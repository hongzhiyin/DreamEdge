import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { initializeSchema } from './schema.js';
import { SessionStoreError } from './types.js';
import type { SessionStore, StoredConversation } from './types.js';
import { validateStored } from './validation.js';
import { readConversations } from './session-rows.js';
import { normalizeRun } from '../conversation/run-data.js';
import { runMetadata, writeToolRows } from './tool-rows.js';

export class SqliteSessionStore implements SessionStore {
  private readonly db: DatabaseSync;
  private closed = false;

  constructor(path: string) {
    let db: DatabaseSync | undefined;
    try {
      if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      db = new DatabaseSync(path);
      if (path !== ':memory:') chmodSync(path, 0o600);
      initializeSchema(db);
      this.db = db;
    } catch (error) {
      db?.close();
      if (error instanceof SessionStoreError) throw error;
      throw new SessionStoreError('OPEN_FAILED', '无法打开会话数据库。');
    }
  }

  load(): StoredConversation[] {
    return this.transaction('BEGIN', 'READ_FAILED', () => {
      const result = readConversations(this.db);
      for (const snapshot of result) validateStored(snapshot);
      return result;
    });
  }

  save(snapshot: StoredConversation, expectedVersion: number | null): void {
    validateStored(snapshot);
    snapshot = { ...structuredClone(snapshot), runs: snapshot.runs.map(normalizeRun) };
    validateStored(snapshot);
    this.transaction('BEGIN IMMEDIATE', 'WRITE_FAILED', () => {
      const { session, messages, runs } = snapshot;
      const current = this.db.prepare('SELECT version FROM sessions WHERE session_id = ?').get(session.sessionId);
      if ((current?.version ?? null) !== expectedVersion
        || (expectedVersion !== null && session.version <= expectedVersion)) {
        throw new SessionStoreError('VERSION_CONFLICT', '会话记录已被其他写入更新。');
      }
      const messageIds = new Set(messages.map(message => message.messageId));
      const runIds = new Set(runs.map(run => run.runId));
      if (this.db.prepare('SELECT message_id FROM messages WHERE session_id = ?').all(session.sessionId)
        .some(row => !messageIds.has(String(row.message_id)))
        || this.db.prepare('SELECT run_id FROM runs WHERE session_id = ?').all(session.sessionId)
          .some(row => !runIds.has(String(row.run_id)))) {
        throw new SessionStoreError('INVALID_DATA', '已保存的提问或运行不能从快照中删除。');
      }
      this.db.prepare(`INSERT INTO sessions VALUES (?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET version = excluded.version, record = excluded.record`)
        .run(session.sessionId, session.version, JSON.stringify(session));
      const messageInsert = this.db.prepare(`INSERT INTO messages VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(message_id) DO UPDATE SET record = excluded.record
        WHERE messages.session_id = excluded.session_id AND messages.client_message_id = excluded.client_message_id
          AND messages.ordinal = excluded.ordinal AND messages.record = excluded.record`);
      for (const [ordinal, message] of messages.entries()) {
        const result = messageInsert.run(message.messageId, session.sessionId, message.clientMessageId, ordinal, JSON.stringify(message));
        if (!result.changes) throw new SessionStoreError('INVALID_DATA', '用户消息归属或顺序不一致。');
      }
      const runInsert = this.db.prepare(`INSERT INTO runs VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id) DO UPDATE SET status = excluded.status, record = excluded.record
        WHERE runs.session_id = excluded.session_id AND runs.user_message_id = excluded.user_message_id
          AND runs.ordinal = excluded.ordinal`);
      for (const [ordinal, run] of runs.entries()) {
        const old = this.db.prepare('SELECT record FROM runs WHERE run_id = ?').get(run.runId);
        if (old && typeof old.record === 'string') {
          const previous = JSON.parse(old.record) as StoredConversation['runs'][number];
          if (previous.toolsSnapshot !== undefined && JSON.stringify(previous.toolsSnapshot) !== JSON.stringify(run.toolsSnapshot)) {
            throw new SessionStoreError('INVALID_DATA', '运行工具定义快照不能变更。');
          }
        }
        const result = runInsert.run(run.runId, session.sessionId, run.userMessageId, ordinal, run.status, runMetadata(run));
        if (!result.changes) throw new SessionStoreError('INVALID_DATA', '回复运行归属或顺序不一致。');
        writeToolRows(this.db, run);
      }
    });
  }

  close(): void {
    if (!this.closed) { this.db.close(); this.closed = true; }
  }

  private transaction<T>(begin: string, code: 'READ_FAILED' | 'WRITE_FAILED', work: () => T): T {
    if (this.closed) throw new SessionStoreError('STORE_CLOSED', '会话数据库已关闭。');
    let began = false;
    try {
      this.db.exec(begin); began = true;
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      if (began) { try { this.db.exec('ROLLBACK'); } catch { /* SQLite may already have rolled back. */ } }
      if (error instanceof SessionStoreError) throw error;
      throw new SessionStoreError(code, code === 'READ_FAILED' ? '无法读取会话数据库。' : '无法保存会话记录。');
    }
  }
}
