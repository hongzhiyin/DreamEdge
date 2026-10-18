import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import type { TestContext } from 'node:test';
import { ConversationService, SqliteSessionStore } from '../../src/index.js';
import type { RuntimeRequest, SessionStore } from '../../src/index.js';
import { ControlledRun } from './conversation.js';
import { connection } from './server.js';

export async function storageFixture(t: TestContext, checkpointMs = 20) {
  const directory = await mkdtemp(join(tmpdir(), 'dreamedge-storage-'));
  const path = join(directory, 'sessions.sqlite');
  const stores: SqliteSessionStore[] = [];
  const services: ConversationService[] = [];
  const calls: ControlledRun[] = [];
  let writeCount = 0;
  let beforeStart: ((request: RuntimeRequest) => void) | undefined;
  const open = () => {
    const sqlite = new SqliteSessionStore(path); stores.push(sqlite);
    const store: SessionStore = { load: () => sqlite.load(), close: () => sqlite.close(),
      save(snapshot, version) { writeCount++; sqlite.save(snapshot, version); } };
    const service = new ConversationService({ store, checkpointMs,
      connection: () => connection('http://127.0.0.1:1'), runtime: () => ({ start(request, observer) {
        beforeStart?.(request);
        const run = new ControlledRun(request, observer); calls.push(run);
        return { cancel: () => { run.cancelCount++; }, done: run.done };
      } }) });
    services.push(service);
    return { service, store: sqlite };
  };
  const initial = open();
  const faults = new DatabaseSync(path);
  const fail = (table: 'sessions' | 'messages' | 'runs', operation: 'INSERT' | 'UPDATE', when = '1') => {
    faults.exec(`CREATE TRIGGER fail_write BEFORE ${operation} ON ${table} WHEN ${when}
      BEGIN SELECT RAISE(ABORT, 'private disk failure'); END`);
  };
  t.after(async () => {
    for (const run of calls) run.finish('cancelled');
    for (const service of services) await service.dispose().catch(() => {});
    faults.close(); for (const store of stores) store.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { ...initial, directory, path, open, calls, faults, fail,
    clearFailure: () => faults.exec('DROP TRIGGER fail_write'),
    writeCount: () => writeCount, onStart: (callback: (request: RuntimeRequest) => void) => { beforeStart = callback; } };
}

export async function waitUntil(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!check()) { assert.ok(Date.now() < deadline, 'Condition timed out'); await delay(5); }
}
