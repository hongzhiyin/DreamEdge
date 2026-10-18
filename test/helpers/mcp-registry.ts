import type { TestContext } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpConnectionRegistry, SqliteMcpRegistryStore, mcpConnectionIdentity } from '../../src/index.js';
import { mcpConfig } from './mcp.js';
export const context = (patch: Record<string, unknown> = {}) => ({ source: 'host-window', appId: 'com.example.alpha', capturedAt: 1000, ...patch });
export function registryMemory(t: TestContext) {
  const store = new SqliteMcpRegistryStore(':memory:'); t.after(() => store.close());
  return { store, registry: new McpConnectionRegistry(store, () => 1000) };
}
export async function registryDisk(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'dreamedge-mcp-registry-')); const path = join(dir, 'registry.sqlite');
  const store = new SqliteMcpRegistryStore(path);
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  return { dir, path, store, registry: new McpConnectionRegistry(store, () => 1000) };
}
export function add(registry: McpConnectionRegistry, serverId = 'alpha') {
  return mcpConnectionIdentity(registry.register(mcpConfig({ serverId })).config);
}
