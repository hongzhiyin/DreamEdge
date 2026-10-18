import { mcpOriginAlias } from '../../src/tools/mcp-origin.js';
import type { TestContext } from 'node:test';
import type { CallToolResult, JsonRpcRequest, ReadResourceResult } from '@earendil-works/pi-mcp';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { ConversationService, PiRuntime, SqliteSessionStore, ToolRegistry, createMcpRunPreparation, mcpToolAlias } from '../../src/index.js';
import { lifecycleFixture, catalogTool } from './mcp-connection.js';
import { modelServer, connection, chatReply } from './server.js';
import { toolReply } from './tool-loop.js';
import { waitUntil } from './storage.js';

export async function mcpRunFixture(t: TestContext, options: {
  operation?: (request: JsonRpcRequest) => Promise<CallToolResult>;
  select?: () => Promise<void>;
  resource?: (uri: string) => Promise<ReadResourceResult>;
} = {}) {
  const mcp = await lifecycleFixture(t); mcp.approve();
  let actions = 0, reads = 0;
  mcp.handle(async (request, reply) => {
    if (request.method === 'tools/list') return reply({ tools: [catalogTool('calculate')] });
    if (request.method === 'resources/list') return reply({ resources: options.resource ? [{ uri: 'fixture://selected', name: 'Selected document' }, { uri: 'fixture://other', name: 'Other document' }] : [] });
    if (request.method === 'resources/templates/list') return reply({ resourceTemplates: [] });
    if (request.method === 'resources/read') { reads++; return reply(await options.resource!(String((request.params as { uri: string }).uri))); }
    if (request.method === 'tools/call') {
      actions++;
      return reply(await (options.operation?.(request) ?? Promise.resolve({ content: [{ type: 'text' as const, text: 'done' }], structuredContent: { total: 2 } })));
    }
  });
  const alias = options.resource ? mcpOriginAlias({ kind: 'mcp-resource', serverId: 'generic', toolName: 'resources/read' }) : mcpToolAlias('generic', 'calculate');
  const server = await modelServer((response, captured) => {
    if (Array.isArray(captured.body.tools) && captured.body.tools.length && !(captured.body.messages as { role: string }[]).some(message => message.role === 'tool')) {
      toolReply(response, [{ id: 'remote-call', name: alias, args: options.resource ? { uri: 'fixture://selected' } : {} }]);
    } else chatReply(response);
  });
  const directory = await mkdtemp(join(tmpdir(), 'dreamedge-mcp-run-'));
  const path = join(directory, 'sessions.sqlite'), store = new SqliteSessionStore(path), faults = new DatabaseSync(path);
  const config = connection(server.baseUrl, { thinkingLevel: 'high',
    toolCalling: { supported: true, supportedThinkingLevels: ['off', 'high'] } });
  const baseRegistry = new ToolRegistry();
  const runtime = (config: import('../../src/index.js').ModelConnectionConfig,
    registry = baseRegistry) => new PiRuntime(config, async () => 'fixture-key', { registry });
  const prepareTools = createMcpRunPreparation(mcp.manager, { baseRegistry, runtime,
    select: async () => { await options.select?.(); return [mcp.ref]; } });
  const service = new ConversationService({ store, connection: () => config, runtime, prepareTools });
  const sessionId = service.createSession({ connectionId: config.id }).sessionId;
  t.after(async () => {
    for (const item of restored) await item.dispose().catch(() => {});
    await service.dispose().catch(() => {}); store.close(); faults.close(); await server.close();
    await rm(directory, { recursive: true, force: true });
  });
  const restored: ConversationService[] = [];
  const restore = (data: import('../../src/storage/types.js').StoredConversation, guard = true) => {
    const recoveredStore = new SqliteSessionStore(join(directory, `recovered-${restored.length}.sqlite`));
    recoveredStore.save(data, null);
    const recovered = new ConversationService({ store: recoveredStore, connection: () => config, runtime,
      ...(guard ? { prepareTools } : {}) });
    restored.push(recovered); return recovered;
  };
  const snapshot = () => service.getSnapshot(sessionId);
  return { ...mcp, service, sessionId, config, server, faults, path, snapshot, store, alias, restore, prepareTools, runtime,
    reads: () => reads,
    actions: () => actions,
    send: () => service.send({ sessionId, clientMessageId: 'one', text: 'Use the generic tool' }),
    pending: async () => { await waitUntil(() => snapshot().runs[0]?.approvals?.some(a => a.status === 'pending') === true); return snapshot().runs[0]!.approvals![0]!; },
    decide: async (decision: 'approve' | 'reject' = 'approve') => {
      await waitUntil(() => snapshot().runs[0]?.approvals?.some(a => a.status === 'pending') === true && snapshot().saveState.status === 'saved');
      const approval = snapshot().runs[0]!.approvals![0]!;
      return service.decideApproval({ ...approval, decision });
    } };
}
