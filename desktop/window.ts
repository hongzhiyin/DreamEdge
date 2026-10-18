import { BrowserWindow, Menu, shell } from 'electron';
import type { MenuItemConstructorOptions } from 'electron';

export function showChatWindow(window: BrowserWindow): void {
  if (window.isDestroyed()) return;
  window.show(); window.focus();
  window.webContents.send('dreamedge:visible');
}

export function chatWindow(preload: string, quitting: () => boolean): BrowserWindow {
  const window = new BrowserWindow({ title: 'DreamEdge', width: 1160, height: 800,
    minWidth: 720, minHeight: 560, show: false, backgroundColor: '#edf9ff',
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 18, y: 16 } } : {}),
    webPreferences: { preload, contextIsolation: true, sandbox: true,
      nodeIntegration: false, webviewTag: false, webSecurity: true } });
  window.on('close', event => { if (!quitting()) { event.preventDefault(); window.hide(); } });
  window.on('show', () => window.webContents.send('dreamedge:visible'));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.setWindowOpenHandler(({ url }) => {
    try { if (['http:', 'https:'].includes(new URL(url).protocol)) void shell.openExternal(url).catch(() => {}); }
    catch { /* Invalid links cannot open another window. */ }
    return { action: 'deny' };
  });
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, respond) => respond(false));
  window.webContents.session.setPermissionCheckHandler(() => false);
  const template: MenuItemConstructorOptions[] = [];
  if (process.platform === 'darwin') template.push({ label: 'DreamEdge', submenu: [
    { role: 'about', label: '关于 DreamEdge' }, { type: 'separator' }, { role: 'hide', label: '隐藏 DreamEdge' },
    { role: 'hideOthers', label: '隐藏其他应用' }, { role: 'unhide', label: '显示所有应用' },
    { type: 'separator' }, { role: 'quit', label: '退出 DreamEdge' },
  ] });
  if (process.platform !== 'darwin') template.push({ label: 'DreamEdge', submenu: [
    { id: 'app-quit', role: 'quit', label: '退出 DreamEdge' },
  ] });
  template.push({ label: '编辑', submenu: [
    { role: 'undo', label: '撤销' }, { role: 'redo', label: '重做' }, { type: 'separator' },
    { role: 'cut', label: '剪切' }, { role: 'copy', label: '复制' }, { role: 'paste', label: '粘贴' },
    { role: 'selectAll', label: '全选' },
  ] }, { label: '窗口', submenu: [{ label: '显示聊天窗口', click: () => showChatWindow(window) },
    { role: 'minimize', label: '最小化' }] });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  return window;
}
