import { join } from 'node:path';
import type { ConversationService } from '../src/conversation/service.js';
import type { CredentialResolver, ModelConnectionConfig } from '../src/model/types.js';
import type { PrepareRunTools } from '../src/conversation/prepared-tools.js';
import { LaunchMcp } from '../src/launch/mcp.js';
import { LaunchStore } from '../src/launch/store.js';
import { McpConnectionRegistry } from '../src/mcp/registry.js';
import { McpConnectionManager } from '../src/mcp/connection-manager.js';
import { SqliteMcpRegistryStore } from '../src/mcp/registry-store.js';

export function launchContext(directory: string, store: LaunchStore, credentials: CredentialResolver,
  service: () => ConversationService, config: ModelConnectionConfig, ordinary: PrepareRunTools) {
  const database = new SqliteMcpRegistryStore(join(directory, 'launch-mcp.sqlite'));
  const registry = new McpConnectionRegistry(database), manager = new McpConnectionManager(registry, { credentials });
  const mcp = new LaunchMcp(store, registry, manager, service, () => config, credentials);
  const external = (id: string) => service().getSnapshot(id).session.externalTools === true;
  const prepare: PrepareRunTools = (connection, context) => (external(context.sessionId) ? mcp.prepare : ordinary)(connection, context);
  prepare.guardHistory = (runs, connection, current) => {
    const id = runs[0]?.sessionId;
    if (id && external(id)) { mcp.check(id); mcp.prepare.guardHistory?.(runs, connection, current); }
    else ordinary.guardHistory?.(runs, connection, current);
  };
  return { mcp, prepare, guard: (id: string) => { if (external(id)) mcp.check(id); },
    close: async () => { await manager.dispose(); database.close(); } };
}
