import { fileURLToPath, pathToFileURL } from 'node:url';
import { chatWindow, showChatWindow } from './window.js';
import { registerChatIpc } from './ipc.js';
import { registerFileScopeIpc } from './file-scopes.js';
import { registerMcpIpc } from './mcp.js';
import { recoverRenderer } from './renderer-recovery.js';
import { installWebMenu, type WebAccess } from './web-host.js';
import type { ChatHub } from '../src/chat/hub.js';
import type { ConversationService } from '../src/conversation/service.js';
import type { McpControl } from '../src/mcp/control.js';

export async function openDesktopUi(hub: ChatHub, service: ConversationService, mcp: McpControl,
  web: WebAccess, quitting: () => boolean, exiting: () => boolean) {
  const window = chatWindow(fileURLToPath(new URL('./preload.cjs', import.meta.url)), quitting);
  const renderer = fileURLToPath(new URL('../renderer/index.html', import.meta.url)), url = pathToFileURL(renderer).href;
  const dispose = [registerChatIpc(window, url, hub), registerFileScopeIpc(window, url, service),
    registerMcpIpc(window, url, mcp), recoverRenderer(window, () => exiting() || quitting())];
  installWebMenu(window, web);
  await window.loadFile(renderer); showChatWindow(window);
  return { show: () => showChatWindow(window), dispose: () => { for (const stop of dispose) stop(); } };
}
