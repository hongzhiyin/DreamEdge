import { mkdtemp, realpath, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { TestContext } from 'node:test';
import { ConversationService, SqliteSessionStore } from '../../src/index.js';
import type { DeviceAccessPolicy } from '../../src/files/scope-types.js';
import { fileDestination } from '../../src/files/scope-types.js';
import { sameDestination } from '../../src/files/scope-validation.js';
import { inspectRoot } from '../../src/files/scope-paths.js';
import { connection } from './server.js';
import { ControlledRun } from './conversation.js';

export async function deviceFixture(t: TestContext) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'dreamedge-device-')));
  const home = join(directory, 'home'); const outside = join(directory, 'another'); await mkdir(home); await mkdir(outside);
  await writeFile(join(home, 'note.txt'), 'device text\n'); await writeFile(join(outside, 'other.txt'), 'other root text\n');
  const policy: DeviceAccessPolicy = { roots: [await inspectRoot(home), await inspectRoot(outside)], baseDirectory: home };
  let enabled = true; let config = connection('http://127.0.0.1:1'); const destination = fileDestination(config);
  const calls: ControlledRun[] = []; const services: ConversationService[] = []; const dbPath = join(directory, 'sessions.sqlite');
  const open = () => {
    const service = new ConversationService({ store: new SqliteSessionStore(dbPath), connection: () => config,
      deviceAccess: current => enabled && sameDestination(fileDestination(current), destination) ? policy : undefined,
      runtime: () => ({ start(request, observer) { const call = new ControlledRun(request, observer); calls.push(call);
        return { cancel: () => call.finish('cancelled'), done: call.done }; } }) });
    services.push(service); return service;
  };
  const service = open(); const session = service.createSession({ connectionId: config.id });
  t.after(async () => { for (const call of calls) call.finish('cancelled'); for (const s of services) await s.dispose().catch(() => {});
    await rm(directory, { recursive: true, force: true }); });
  const start = (current = service, sid = session.sessionId) => {
    const handle = current.send({ sessionId: sid, clientMessageId: crypto.randomUUID(), text: 'fixture' });
    return { handle, source: { sessionId: sid, runId: handle.runId, turnId: 'turn', toolCallId: 'file' } };
  };
  return { service, session, directory, home, outside, dbPath, open, start, policy,
    set: (value: boolean) => { enabled = value; service.refreshDeviceAccess(); },
    changeModel: () => { config = { ...config, model: 'other-model' }; service.refreshDeviceAccess(); } };
}
