import { ipcMain } from 'electron';
import type { BrowserWindow, WebContents } from 'electron';
import type { ChatHub } from '../src/chat/hub.js';

export function registerChatIpc(window: BrowserWindow, rendererUrl: string, hub: ChatHub): () => void {
  const watched = new Map<WebContents, string>();
  ipcMain.handle('dreamedge:chat', (event, command: unknown) => {
    if (event.sender !== window.webContents || event.senderFrame !== event.sender.mainFrame
      || event.senderFrame.url !== rendererUrl) {
      return { ok: false, error: { code: 'INVALID_SENDER', message: '聊天页面连接无效。' } };
    }
    const reply = hub.execute(command);
    if (reply.ok && typeof command === 'object' && command !== null
      && 'type' in command && command.type === 'watch' && 'sessionId' in command) {
      if (!watched.has(event.sender)) event.sender.once('destroyed', () => { watched.delete(event.sender); });
      watched.set(event.sender, String(command.sessionId));
    }
    return reply;
  });
  const unsubscribe = hub.subscribe(event => {
    for (const [contents, sessionId] of watched) {
      if (sessionId === event.sessionId && !contents.isDestroyed() && window.isVisible()) {
        contents.send('dreamedge:update', event);
      }
    }
  });
  return () => { ipcMain.removeHandler('dreamedge:chat'); unsubscribe(); watched.clear(); };
}
