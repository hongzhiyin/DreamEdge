import type { TestContext } from 'node:test';
import { McpClient, isJsonRpcRequest } from '@earendil-works/pi-mcp';
import type { JsonRpcMessage, JsonRpcRequest } from '@earendil-works/pi-mcp';
import { createInMemoryTransportPair } from '@earendil-works/pi-mcp/testing';
import { mcpClientOptions, parseMcpServerConfig } from '../../src/index.js';

export const mcpConfig = (patch: Record<string, unknown> = {}) => ({ format: 'dreamedge-mcp-server/v1',
  serverId: 'generic-fixture', displayName: 'Generic fixture', configRevision: 1, enabled: true,
  transport: { type: 'stdio', command: '/configured/mcp-service', args: ['serve'] },
  policy: { connect: 'ask', tools: 'ask', resources: 'ask' }, ...patch });

export async function mcpFixture(t: TestContext, options: {
  version?: string; timeoutMs?: number;
  handle?: (request: JsonRpcRequest, reply: (result: unknown) => Promise<void>) => void | Promise<void>;
} = {}) {
  const pair = createInMemoryTransportPair(); const messages: JsonRpcMessage[] = [];
  const client = new McpClient(mcpClientOptions(parseMcpServerConfig(mcpConfig({ requestTimeoutMs: options.timeoutMs ?? 1000 }))));
  const errors: unknown[] = [];
  pair.server.onMessage(message => {
    messages.push(message); if (!isJsonRpcRequest(message)) return;
    const reply = (result: unknown) => pair.server.send({ jsonrpc: '2.0', id: message.id, result });
    const work = message.method === 'initialize' ? reply({ protocolVersion: options.version ?? '2025-11-25',
      serverInfo: { name: 'generic-fixture', version: '1' }, capabilities: { tools: { listChanged: true }, resources: {} } })
      : options.handle?.(message, reply);
    void Promise.resolve(work).catch(error => errors.push(error));
  });
  await pair.server.start();
  t.after(async () => { await client.close(); await pair.server.close(); if (errors.length) throw new Error('Fixture response failed'); });
  return { client, pair, messages, connect: () => client.connect(pair.client) };
}
