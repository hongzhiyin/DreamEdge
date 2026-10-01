import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { StoredRecord, StorageRequest } from '../shared/contracts';
import { identifier, validateStorage } from './validation';

export class ToolStorage {
  private readonly db: DatabaseSync;

  constructor(filename: string) {
    mkdirSync(dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS records (
        tool_id TEXT NOT NULL,
        collection TEXT NOT NULL,
        id TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (tool_id, collection, id)
      );
      PRAGMA user_version = 1;
    `);
  }

  execute(toolId: string, request: StorageRequest): StoredRecord[] | void {
    identifier(toolId);
    validateStorage(request);
    if (request.operation === 'list') {
      const rows = this.db.prepare(
        'SELECT id, value FROM records WHERE tool_id = ? AND collection = ? ORDER BY id',
      ).all(toolId, request.collection);
      return rows.map(row => ({ id: String(row.id), value: JSON.parse(String(row.value)) }));
    }
    if (request.operation === 'put') {
      this.db.prepare(`INSERT INTO records VALUES (?, ?, ?, ?)
        ON CONFLICT (tool_id, collection, id) DO UPDATE SET value = excluded.value`)
        .run(toolId, request.collection, request.id, JSON.stringify(request.value));
      return;
    }
    this.db.prepare('DELETE FROM records WHERE tool_id = ? AND collection = ? AND id = ?')
      .run(toolId, request.collection, request.id);
  }

  close(): void {
    this.db.close();
  }
}
