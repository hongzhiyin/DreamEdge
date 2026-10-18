import type { DatabaseSync } from 'node:sqlite';
import { SessionStoreError } from './types.js';
import { readConversations } from './session-rows.js';
import { validateStored } from './validation.js';
import { normalizeRun, hasRunData } from '../conversation/run-data.js';
import { runMetadata, writeToolRows } from './tool-rows.js';

export function initializeSchema(db: DatabaseSync): void {
  const version = db.prepare('PRAGMA user_version').get()?.user_version;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 0 || version > 9) {
    throw new SessionStoreError('UNSUPPORTED_SCHEMA', '会话数据库版本不受支持。');
  }
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 1000;
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
  `);
  if (version === 9) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_id TEXT PRIMARY KEY, version INTEGER NOT NULL, record TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      message_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, client_message_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL, record TEXT NOT NULL,
      UNIQUE(session_id, client_message_id), UNIQUE(session_id, message_id), UNIQUE(session_id, ordinal),
      FOREIGN KEY(session_id) REFERENCES sessions(session_id)
    );
    CREATE TABLE IF NOT EXISTS runs (
      run_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, user_message_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL, status TEXT NOT NULL, record TEXT NOT NULL,
      UNIQUE(session_id, ordinal),
      FOREIGN KEY(session_id, user_message_id) REFERENCES messages(session_id, message_id)
    );
    CREATE INDEX IF NOT EXISTS messages_order ON messages(session_id, ordinal);
    CREATE INDEX IF NOT EXISTS runs_order ON runs(session_id, ordinal);
    CREATE UNIQUE INDEX IF NOT EXISTS runs_identity ON runs(session_id, run_id);
    CREATE TABLE IF NOT EXISTS run_messages (
      message_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, session_id TEXT NOT NULL,
      turn_id TEXT NOT NULL, ordinal INTEGER NOT NULL CHECK(ordinal >= 0), record TEXT NOT NULL,
      UNIQUE(run_id, ordinal), FOREIGN KEY(session_id, run_id) REFERENCES runs(session_id, run_id)
    );
    CREATE TABLE IF NOT EXISTS tool_calls (
      run_id TEXT NOT NULL, tool_call_id TEXT NOT NULL, session_id TEXT NOT NULL, turn_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL CHECK(ordinal >= 0), status TEXT NOT NULL, record TEXT NOT NULL, approvals TEXT NOT NULL,
      PRIMARY KEY(run_id, tool_call_id), UNIQUE(run_id, ordinal),
      FOREIGN KEY(session_id, run_id) REFERENCES runs(session_id, run_id)
    );
    `);
    if (version === 1 || version === 2) {
      for (const snapshot of readConversations(db, version === 2)) {
        if (snapshot.session.fileScope !== undefined) throw new SessionStoreError('INVALID_DATA', '旧版本数据库含有未声明的文件范围。');
      }
    }
    if (version === 1) {
      for (const snapshot of readConversations(db, false)) {
        validateStored(snapshot);
        for (const source of snapshot.runs) {
          if ([source.toolsSnapshot, source.transcript, source.toolCalls, source.approvals].some(value => value !== undefined)) {
            throw new SessionStoreError('INVALID_DATA', 'v1 数据库含有不兼容的工具记录。');
          }
          const run = normalizeRun(source);
          if (hasRunData(run)) {
            db.prepare('UPDATE runs SET record = ? WHERE run_id = ?').run(runMetadata(run), run.runId);
            writeToolRows(db, run);
          }
        }
      }
    }
    for (const snapshot of readConversations(db)) {
      if (version !== 0 && version < 5 && snapshot.session.fileScope?.grants.some(g => g.device !== undefined)) {
        throw new SessionStoreError('INVALID_DATA', '旧数据库含有未声明的整机授权。');
      }
      if (version === 3 && snapshot.runs.some(run => run.toolCalls?.some(call => call.preview) || run.approvals?.some(a => a.file))) {
        throw new SessionStoreError('INVALID_DATA', '旧数据库含有未声明的文件变更计划。');
      }
      if (version < 6 && snapshot.runs.some(run => run.batchRecovery || run.toolCalls?.some(call => call.status === 'authorized')
        || run.approvals?.some(a => a.batch || a.batchPlan))) throw new SessionStoreError('INVALID_DATA', '旧数据库含有未声明的批量计划。');
      if (version < 7 && snapshot.runs.some(run => run.toolCalls?.some(call => call.preview?.kind === 'file_operation'))) throw new SessionStoreError('INVALID_DATA', '旧数据库含有未声明的结构操作。');
      if (version < 8 && snapshot.runs.some(run => run.toolsSnapshot?.some(tool => tool.origin))) throw new SessionStoreError('INVALID_DATA', '旧数据库含有未声明的 MCP 工具来源。');
      if (snapshot.runs.some(run => run.toolsSnapshot?.some(tool => tool.origin?.kind === 'mcp-resource'))) throw new SessionStoreError('INVALID_DATA', '旧数据库含有未声明的 MCP 资源记录。');
      validateStored(snapshot);
    }
    db.exec('PRAGMA user_version = 9; COMMIT;');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* Preserve the original failure. */ }
    if (error instanceof SessionStoreError) throw error;
    throw new SessionStoreError('MIGRATION_FAILED', '会话数据库升级失败，原记录保持不变。');
  }
}
