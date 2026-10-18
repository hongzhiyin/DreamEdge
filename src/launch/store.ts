import { DatabaseSync } from 'node:sqlite';
import { LaunchError, applicationKey, contextKey, type OpenSession, type LaunchApp } from './protocol.js';
import type { LaunchReadGrant } from './grant.js';

/** Separate durable ownership index; chat contents remain in the existing session store. */
export class LaunchStore {
  private readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS trust (app TEXT PRIMARY KEY, name TEXT NOT NULL, destination TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS scoped_trust (app TEXT NOT NULL, destination TEXT NOT NULL, name TEXT NOT NULL, PRIMARY KEY(app,destination));
      CREATE TABLE IF NOT EXISTS automatic_blocks (app TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS bindings (binding TEXT PRIMARY KEY, app TEXT NOT NULL, session TEXT NOT NULL, context TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS requests (app TEXT NOT NULL, id TEXT NOT NULL, binding TEXT NOT NULL, PRIMARY KEY(app,id));
      CREATE TABLE IF NOT EXISTS read_grants (session TEXT PRIMARY KEY, grant_json TEXT NOT NULL);`);
  }
  trusted(app: LaunchApp, destination: string): boolean {
    const scope = this.db.prepare('SELECT name FROM scoped_trust WHERE app=? AND destination=?').get(applicationKey(app), destination);
    if (scope?.name === app.name) return true;
    const row = this.db.prepare('SELECT name,destination FROM trust WHERE app=?').get(applicationKey(app));
    return row?.name === app.name && row.destination === destination;
  }
  approve(app: LaunchApp, destination: string): void {
    this.db.prepare('DELETE FROM automatic_blocks WHERE app=?').run(applicationKey(app));
    this.db.prepare('INSERT OR REPLACE INTO scoped_trust VALUES (?,?,?)').run(applicationKey(app), destination, app.name);
  }
  revoke(app: LaunchApp): string[] {
    this.db.prepare('INSERT OR IGNORE INTO automatic_blocks VALUES (?)').run(applicationKey(app));
    this.db.prepare('DELETE FROM trust WHERE app=?').run(applicationKey(app));
    this.db.prepare('DELETE FROM scoped_trust WHERE app=?').run(applicationKey(app));
    return this.db.prepare('SELECT session FROM bindings WHERE app=?').all(applicationKey(app)).map(row => String(row.session));
  }
  owns(session: string): boolean { return !!this.db.prepare('SELECT 1 FROM bindings WHERE session=?').get(session); }
  automaticBlocked(app: LaunchApp): boolean {
    return !!this.db.prepare('SELECT 1 FROM automatic_blocks WHERE app=?').get(applicationKey(app));
  }
  grant(session: string): LaunchReadGrant | undefined {
    const row = this.db.prepare('SELECT grant_json FROM read_grants WHERE session=?').get(session);
    return row ? JSON.parse(String(row.grant_json)) as LaunchReadGrant : undefined;
  }
  saveGrant(session: string, grant: LaunchReadGrant): void {
    this.db.prepare('INSERT OR REPLACE INTO read_grants VALUES (?,?)').run(session, JSON.stringify(grant));
  }
  resolve(request: OpenSession): string | undefined {
    const old = this.db.prepare('SELECT binding FROM requests WHERE app=? AND id=?').get(applicationKey(request.application), request.requestId);
    if (old && old.binding !== contextKey(request)) throw new LaunchError('REQUEST_CONFLICT', '请求标识已经用于另一个上下文。');
    const row = this.db.prepare('SELECT session FROM bindings WHERE binding=?').get(contextKey(request));
    return row ? String(row.session) : undefined;
  }
  save(request: OpenSession, session: string): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT OR REPLACE INTO bindings VALUES (?,?,?,?)').run(contextKey(request), applicationKey(request.application), session, JSON.stringify(request.context));
      this.db.prepare('INSERT OR IGNORE INTO requests VALUES (?,?,?)').run(applicationKey(request.application), request.requestId, contextKey(request));
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  close(): void { this.db.close(); }
}
