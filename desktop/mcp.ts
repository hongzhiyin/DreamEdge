import { McpJsonSettings } from '../src/mcp/json-settings.js';
import { ipcMain } from 'electron';
import type { BrowserWindow } from 'electron';
import { join } from 'node:path';
import type { CredentialResolver, ModelConnectionConfig } from '../src/model/types.js';
import type { ConversationService } from '../src/conversation/service.js';
import type { ToolRegistry } from '../src/tools/registry.js';
import { PiRuntime } from '../src/runtime/pi-runtime.js';
import { McpConnectionRegistry } from '../src/mcp/registry.js';
import { SqliteMcpRegistryStore } from '../src/mcp/registry-store.js';
import { McpConnectionManager } from '../src/mcp/connection-manager.js';
import { McpControl, mcpControlHandler } from '../src/mcp/control.js';
import { createMcpRunPreparation } from '../src/mcp/run-preparation.js';
import { installedAdapters } from '../src/adapters/installed.js';

export function desktopMcp(directory: string, credentials: CredentialResolver, baseRegistry: ToolRegistry,
  service: () => ConversationService, config: ModelConnectionConfig) {
  const store = new SqliteMcpRegistryStore(join(directory, 'mcp.sqlite'));
  const registry = new McpConnectionRegistry(store), manager = new McpConnectionManager(registry, { credentials });
  const adapters = installedAdapters(directory);
  const settings = new McpJsonSettings(join(directory, 'mcp.json'), registry);
  const control = new McpControl(registry, manager, service, () => config, adapters, settings);
  const prepareTools = createMcpRunPreparation(manager, { baseRegistry,
    select: context => control.select(context.sessionId), runtime: (connection, tools) => new PiRuntime(connection, credentials, { registry: tools }) });
  return { control, prepareTools, handler: mcpControlHandler(control),
    guardHistory: (sessionId: string, connection: ModelConnectionConfig) => {
      for (const adapter of adapters) adapter.guardHistory(service().getSnapshot(sessionId).runs, connection);
    },
    close: async () => { await manager.dispose(); store.close(); } };
}
export function registerMcpIpc(window: BrowserWindow, url: string, control: McpControl) {
  const handler = mcpControlHandler(control);
  ipcMain.handle('dreamedge:mcp', (event, command: unknown) => {
    if (event.sender !== window.webContents || event.senderFrame !== event.sender.mainFrame || event.senderFrame.url !== url) {
      return { ok: false, error: { code: 'INVALID_SENDER', message: '连接请求来源无效。' } };
    }
    return handler(command);
  });
  return () => ipcMain.removeHandler('dreamedge:mcp');
}
