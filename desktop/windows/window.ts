import { BrowserWindow, screen, session } from 'electron';
import { join } from 'node:path';
import type { WindowBounds } from '../../shared/contracts';
import { serveAsset } from '../assets';
import { WindowContext } from './context';

export function restoredBounds(saved: WindowBounds | null): WindowBounds {
  const area = saved ? screen.getDisplayMatching(saved).workArea : screen.getPrimaryDisplay().workArea;
  const width = Math.min(area.width, Math.max(640, saved?.width ?? 1180));
  const height = Math.min(area.height, Math.max(480, saved?.height ?? 850));
  return { width, height, x: Math.max(area.x, Math.min(saved?.x ?? area.x + 40, area.x + area.width - width)),
    y: Math.max(area.y, Math.min(saved?.y ?? area.y + 40, area.y + area.height - height)) };
}
export function createHostWindow(context: WindowContext, id: string, root: string, preload: string, resourceId: string, bounds: WindowBounds | null): BrowserWindow {
  const scopedSession = session.fromPartition(`persist:dreamedge-window-${id}`);
  scopedSession.protocol.handle('dreamedge', request => {
    const tools = context.tools(); const aliases = new Map([[tools[0].id, resourceId]]);
    const host = new URL(request.url).hostname;
    return serveAsset(join(root, 'dist'), request.url, tools, aliases, host === 'shell' ? 'dreamedge:' : undefined);
  });
  scopedSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  scopedSession.setPermissionCheckHandler(() => false);
  scopedSession.webRequest.onBeforeRequest((request, callback) => {
    const url = new URL(request.url);
    callback({ cancel: url.protocol !== 'dreamedge:' || !['shell', context.tools()[0].id].includes(url.hostname) });
  });
  const denyDownload = (event: Electron.Event) => event.preventDefault();
  scopedSession.on('will-download', denyDownload);
  const window = new BrowserWindow({ ...restoredBounds(bounds), minWidth: 640, minHeight: 480,
    backgroundColor: '#f7f8f5', autoHideMenuBar: false, title: 'DreamEdge',
    webPreferences: { session: scopedSession, preload, contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('will-frame-navigate', event => {
    const tool = context.tools()[0];
    if (!event.isMainFrame && event.url !== `dreamedge://${tool.id}/${tool.entry}`) event.preventDefault();
  });
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.on('closed', () => { scopedSession.removeListener('will-download', denyDownload); scopedSession.protocol.unhandle('dreamedge'); });
  return window;
}
