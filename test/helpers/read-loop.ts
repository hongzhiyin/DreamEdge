import { mkdtemp, mkdir, rm, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { ConversationService, PiRuntime, SqliteSessionStore, builtInTools, scopedReadTools, readToolNames } from '../../src/index.js';
import { modelServer, connection } from './server.js';
import type { Handler } from './server.js';

export async function readLoopFixture(t: TestContext, handler: Handler) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'dreamedge-read-loop-'))); const root = join(directory, 'files');
  await mkdir(root); await writeFile(join(root, 'note.txt'), 'remembered file secret\nneedle\n');
  const server = await modelServer(handler); const registry = builtInTools();
  const config = connection(server.baseUrl, { thinkingLevel: 'high', timeoutMs: 30_000,
    toolCalling: { supported: true, supportedThinkingLevels: ['off', 'high'] } });
  const store = new SqliteSessionStore(join(directory, 'sessions.sqlite'));
  const service = new ConversationService({ store, directoryPicker: async () => root, connection: () => config,
    tools: (config, sessionId) => registry.snapshots().filter(tool => !readToolNames.includes(tool.name as never)
      || Boolean(sessionId && service.fileScopes.roots(sessionId, config).length)),
    runtime: config => new PiRuntime(config, async () => 'fixture-key', { registry }) });
  const cacheRoot = join(directory, 'cache'); await mkdir(cacheRoot, { mode: 0o700 });
  for (const tool of await scopedReadTools(service.fileScopes, {}, cacheRoot)) registry.register(tool);
  const sessionId = service.createSession({ connectionId: config.id }).sessionId;
  t.after(async () => { await service.dispose().catch(() => {}); store.close(); await server.close(); await rm(directory, { recursive: true, force: true }); });
  return { service, config, server, store, root, sessionId, cacheRoot,
    grant: () => service.fileScopes.chooseDirectory(sessionId, { mode: 'read', remember: true }),
    send: (id = 'one') => service.send({ sessionId, clientMessageId: id, text: id }) };
}
