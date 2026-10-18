import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { TestContext } from 'node:test';
import type { ServerResponse } from 'node:http';
import { ConversationService, PiRuntime, SqliteSessionStore, builtInTools } from '../../src/index.js';
import type { ToolRegistry, ToolRuntimeOptions } from '../../src/index.js';
import { modelServer, connection, beginSse, chatChunk } from './server.js';
import type { Handler } from './server.js';

export function toolReply(response: ServerResponse, calls: { id: string; name: string; args: unknown }[], finish = 'tool_calls') {
  beginSse(response); chatChunk(response, { role: 'assistant' });
  chatChunk(response, { reasoning_content: 'tool reasoning' });
  chatChunk(response, { tool_calls: calls.map((call, index) => ({ index, id: call.id, type: 'function',
    function: { name: call.name, arguments: JSON.stringify(call.args) } })) });
  chatChunk(response, {}, finish); response.end('data: [DONE]\n\n');
}

export async function toolLoopFixture(t: TestContext, handler: Handler,
  registry: ToolRegistry = builtInTools(), options: ToolRuntimeOptions = {}) {
  const server = await modelServer(handler);
  const directory = await mkdtemp(join(tmpdir(), 'dreamedge-tool-loop-'));
  const path = join(directory, 'sessions.sqlite'); const store = new SqliteSessionStore(path);
  const faults = new DatabaseSync(path);
  const config = connection(server.baseUrl, { thinkingLevel: 'high',
    toolCalling: { supported: true, supportedThinkingLevels: ['off', 'low', 'high'] } });
  const service = new ConversationService({ store, connection: () => config, tools: () => registry.snapshots(),
    runtime: config => new PiRuntime(config, async () => 'fixture-key', { ...options, registry }) });
  const sessionId = service.createSession({ connectionId: config.id }).sessionId;
  t.after(async () => {
    await service.dispose().catch(() => {}); store.close(); faults.close(); await server.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { service, store, faults, server, registry, config, path, sessionId,
    send: (text = 'Use the tools') => service.send({ sessionId, clientMessageId: 'one', text }) };
}
