import { mkdtemp, mkdir, rm, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { ConversationService, SqliteSessionStore } from '../../src/index.js';
import type { ModelConnectionConfig, FileGrantOptions } from '../../src/index.js';
import { ControlledRun } from './conversation.js';
import { connection } from './server.js';

export async function scopeFixture(t: TestContext) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'dreamedge-scopes-')));
  const root = join(directory, 'root'); const outside = join(directory, 'outside');
  await mkdir(root); await mkdir(outside); await mkdir(join(directory, 'root-other'));
  await writeFile(join(root, 'input.txt'), 'authorized contents\n'); await writeFile(join(outside, 'secret.txt'), 'outside secret');
  let selected: string | undefined = root; let clock = Date.now(); let config: ModelConnectionConfig = connection('http://127.0.0.1:1');
  const calls: ControlledRun[] = []; const services: ConversationService[] = []; const stores: SqliteSessionStore[] = [];
  const dbPath = join(directory, 'sessions.sqlite');
  const open = () => {
    const store = new SqliteSessionStore(dbPath); stores.push(store);
    const service = new ConversationService({ store, now: () => clock,
      connection: () => config, directoryPicker: async () => selected,
      runtime: () => ({ start(request, observer) { const run = new ControlledRun(request, observer); calls.push(run);
        return { cancel: () => {}, done: run.done }; } }) });
    services.push(service); return service;
  };
  const service = open(); const session = service.createSession({ connectionId: config.id });
  t.after(async () => { for (const run of calls) run.finish('cancelled');
    for (const s of services) await s.dispose().catch(() => {});
    for (const store of stores) store.close(); await rm(directory, { recursive: true, force: true }); });
  const choose = (options: FileGrantOptions = { mode: 'read', remember: false }) => service.fileScopes.chooseDirectory(session.sessionId, options);
  const start = () => {
    const handle = service.send({ sessionId: session.sessionId, clientMessageId: String(calls.length), text: 'fixture' });
    return { handle, source: { sessionId: session.sessionId, runId: handle.runId, turnId: 'turn', toolCallId: 'read' } };
  };
  return { service, session, root, outside, directory, dbPath, open, calls, choose, start,
    select: (path: string | undefined) => { selected = path; }, advance: (ms: number) => { clock += ms; },
    changeModel: () => { config = { ...config, model: 'new-model' }; } };
}
