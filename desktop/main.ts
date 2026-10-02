import { app, BrowserWindow, dialog, ipcMain, protocol, session } from 'electron';
import { join, resolve } from 'node:path';
import { catalog, requireTool } from './catalog';
import { serveAsset } from './assets';
import { ToolStorage } from './storage';
import { SHELL_URL } from '../shared/contracts';

app.setName('DreamEdge');
const dataDirectory = process.env.DREAMEDGE_DATA_DIR;
app.setPath('userData', dataDirectory ? resolve(dataDirectory) : join(app.getPath('appData'), 'DreamEdge'));
protocol.registerSchemesAsPrivileged([{ scheme: 'dreamedge', privileges: {
  standard: true, secure: true, supportFetchAPI: true,
} }]);

let storage: ToolStorage | undefined;

function createWindow(): void {
  const window = new BrowserWindow({
    title: 'DreamEdge', width: 1260, height: 850, minWidth: 920, minHeight: 650,
    backgroundColor: '#f7f8f5', autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, 'preload.js'), contextIsolation: true,
      sandbox: true, nodeIntegration: false, webSecurity: true,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('will-frame-navigate', event => {
    if (!event.isMainFrame && event.url !== 'dreamedge://reading-log/index.html') {
      event.preventDefault();
    }
  });
  void window.loadURL(SHELL_URL);
}

app.whenReady().then(() => {
  storage = new ToolStorage(join(app.getPath('userData'), 'data', 'dreamedge.sqlite'));
  protocol.handle('dreamedge', request => serveAsset(join(app.getAppPath(), 'dist'), request.url));
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  function trust(event: Electron.IpcMainInvokeEvent): void {
    if (event.senderFrame !== event.sender.mainFrame || event.senderFrame?.url !== SHELL_URL) {
      throw new Error('仅允许宿主调用此接口。');
    }
  }
  ipcMain.handle('host:tools', event => { trust(event); return catalog; });
  ipcMain.handle('host:storage', (event, toolId, request) => {
    trust(event);
    const tool = requireTool(toolId);
    if (!tool.capabilities.includes('storage')) throw new Error('工具没有存储权限。');
    return storage!.execute(tool.id, request);
  });
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
}).catch(error => {
  dialog.showErrorBox('DreamEdge 无法启动', String(error));
  app.quit();
});

app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => storage?.close());
