import { DatabaseSync } from 'node:sqlite';
import { chmodSync, lstatSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { McpRegistryState, McpRegistryStore } from './registry-types.js';
import { emptyMcpRegistry, parseMcpRegistry, McpRegistryError } from './registry-validation.js';

/** Separate host-owned database; never changes the conversation database schema. */
export class SqliteMcpRegistryStore implements McpRegistryStore {
  private readonly db: DatabaseSync;
  private closed = false;
  constructor(path: string) {
    let db: DatabaseSync | undefined;
    try {
      if (path !== ':memory:') {
        try { if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw new McpRegistryError('STORE_FAILED'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      }
      db = new DatabaseSync(path);
      const version = db.prepare('PRAGMA user_version').get()?.user_version;
      if (version !== 0 && version !== 1) throw new McpRegistryError('INVALID_REGISTRY');
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
      if ((version === 0 && tables.length) || (version === 1 && (tables.length !== 1 || tables[0]?.name !== 'mcp_registry'))) throw new McpRegistryError('INVALID_REGISTRY');
      if (path !== ':memory:') chmodSync(path, 0o600);
      db.exec('PRAGMA busy_timeout=1000; PRAGMA synchronous=FULL');
      if (version === 0) {
        db.exec('BEGIN IMMEDIATE');
        db.exec('CREATE TABLE mcp_registry(id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, record TEXT NOT NULL); PRAGMA user_version=1');
        db.prepare('INSERT INTO mcp_registry VALUES(1, 0, ?)').run(JSON.stringify(emptyMcpRegistry())); db.exec('COMMIT');
      }
      this.db = db; this.load();
    } catch (error) { db?.close(); if (error instanceof McpRegistryError) throw error; throw new McpRegistryError('STORE_FAILED'); }
  }
  load(): McpRegistryState {
    if (this.closed) throw new McpRegistryError('CLOSED');
    try {
      const row = this.db.prepare('SELECT revision, record FROM mcp_registry WHERE id=1').get();
      if (!row || typeof row.record !== 'string' || Buffer.byteLength(row.record, 'utf8') > 4 * 1024 * 1024) throw new McpRegistryError('INVALID_REGISTRY');
      const state = parseMcpRegistry(JSON.parse(row.record)); if (state.revision !== row.revision) throw new McpRegistryError('INVALID_REGISTRY'); return state;
    } catch (error) { if (error instanceof McpRegistryError) throw error; throw new McpRegistryError('STORE_FAILED'); }
  }
  save(value: McpRegistryState, expectedRevision: number): void {
    if (this.closed) throw new McpRegistryError('CLOSED');
    const state = parseMcpRegistry(value); const record = JSON.stringify(state);
    if (Buffer.byteLength(record, 'utf8') > 4 * 1024 * 1024 || state.revision !== expectedRevision + 1) throw new McpRegistryError('INVALID_REGISTRY');
    let began = false;
    try {
      this.db.exec('BEGIN IMMEDIATE'); began = true;
      if (this.db.prepare('SELECT revision FROM mcp_registry WHERE id=1').get()?.revision !== expectedRevision) throw new McpRegistryError('CONFLICT');
      const written = this.db.prepare('UPDATE mcp_registry SET revision=?, record=? WHERE id=1').run(state.revision, record);
      const saved = this.db.prepare('SELECT revision, record FROM mcp_registry WHERE id=1').get();
      if (written.changes !== 1 || saved?.revision !== state.revision || saved?.record !== record) throw new McpRegistryError('STORE_FAILED');
      this.db.exec('COMMIT');
    } catch (error) { if (began) { try { this.db.exec('ROLLBACK'); } catch {} }
      if (error instanceof McpRegistryError) throw error; throw new McpRegistryError('STORE_FAILED'); }
  }
  close(): void { if (!this.closed) { this.db.close(); this.closed = true; } }
}
