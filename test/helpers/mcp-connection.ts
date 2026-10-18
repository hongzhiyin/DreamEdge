import type { TestContext } from 'node:test';
import { createInMemoryTransportPair } from '@earendil-works/pi-mcp/testing';
import { isJsonRpcRequest } from '@earendil-works/pi-mcp';
import type { JsonRpcMessage, JsonRpcRequest, McpTransport, Tool } from '@earendil-works/pi-mcp';
import { McpConnectionManager, mcpConnectionIdentity } from '../../src/index.js';
import type { McpConnectionOptions } from '../../src/index.js';
import { registryMemory } from './mcp-registry.js';
import { mcpConfig } from './mcp.js';
export const catalogTool = (name = 'operation'): Tool => ({ name, description: 'Generic operation', inputSchema: { type: 'object', properties: {}, additionalProperties: false } });
export async function lifecycleFixture(t: TestContext, options: McpConnectionOptions = {}) {
  const { store, registry } = registryMemory(t);
  const ref = mcpConnectionIdentity(registry.register(mcpConfig({ serverId: 'generic', requestTimeoutMs: 500 })).config);
  const servers: McpTransport[] = [], messages: JsonRpcMessage[][] = [];
  let tools = [catalogTool()]; let version = '2025-11-25'; let failFactory: Error | undefined;
  let handler: ((request: JsonRpcRequest, reply: (value: unknown) => Promise<void>) => Promise<void> | void) | undefined;
  const factory = async () => {
    if (failFactory) throw failFactory;
    const pair = createInMemoryTransportPair(); const received: JsonRpcMessage[] = []; messages.push(received); servers.push(pair.server);
    pair.server.onMessage(message => {
      received.push(message); if (!isJsonRpcRequest(message)) return;
      const reply = (result: unknown) => pair.server.send({ jsonrpc: '2.0', id: message.id, result });
      const work = message.method === 'initialize' ? reply({ protocolVersion: version, serverInfo: { name: 'fixture', version: '1' },
        capabilities: { tools: { listChanged: true }, resources: { listChanged: true } } }) : handler ? handler(message, reply)
        : reply(message.method === 'tools/list' ? { tools } : message.method === 'resources/list'
          ? { resources: [{ uri: 'fixture://resource', name: 'resource' }] } : { resourceTemplates: [{ uriTemplate: 'fixture://{id}', name: 'template' }] });
      void Promise.resolve(work).catch(() => {}); // Late fixture responses after cancellation are intentionally ignored.
    });
    await pair.server.start(); return pair.client;
  };
  const manager = new McpConnectionManager(registry, { transportFactory: factory, ...options });
  t.after(async () => { await manager.dispose(); await Promise.all(servers.map(s => s.close())); });
  return { manager, registry, store, ref, servers, messages, approve: () => registry.approveConnection(ref),
    setTools: (value: Tool[]) => { tools = value; }, setVersion: (value: string) => { version = value; },
    setFactoryFailure: (value: Error) => { failFactory = value; },
    handle: (value: typeof handler) => { handler = value; } };
}
