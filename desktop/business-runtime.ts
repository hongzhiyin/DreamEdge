import { app, BrowserWindow, dialog, ipcMain, Menu, protocol } from 'electron';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { applicationDataDirectory, loadApplication } from './project';
import { serveAsset } from './assets';
import { ToolStorage } from './storage';
import { createServices } from './services';
import { secureWindow } from './windows/security';
import { SHELL_URL, type Json, type StorageRequest } from '../shared/contracts';

/** Production runtime: compiled business content and declared data/services only. */
export function startBusinessApp(): void {
  const root = app.getAppPath(); const manifest = loadApplication(root);
  if (manifest.capabilities.includes('workspace')) throw new Error('业务 App 的开发请在 DreamEdge 中打开原工程。');
  const profile = process.env.DREAMEDGE_DATA_DIR ? resolve(process.env.DREAMEDGE_DATA_DIR) : applicationDataDirectory(app.getPath('appData'), manifest);
  app.setName(manifest.name); app.setPath('userData', profile); app.setAppUserModelId(manifest.appId);
  if (!app.requestSingleInstanceLock()) { app.quit(); return; }
  protocol.registerSchemesAsPrivileged([{ scheme: 'dreamedge', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
  let window: BrowserWindow | undefined; let database: ToolStorage | undefined; let closing = false;
  const services = createServices(manifest, root, profile);
  const unavailable = () => { throw new Error('业务 App 不提供工程开发能力，请在 DreamEdge 中打开原业务工程。'); };
  function handle(channel: string, action: (...args: any[]) => unknown) {
    ipcMain.handle(channel, async (event, ...args) => {
      try {
        if (closing || !window || event.sender !== window.webContents || event.senderFrame !== event.sender.mainFrame || event.senderFrame?.url !== SHELL_URL) throw new Error('应用调用来源无效。');
        return { ok: true, result: await action(...args) };
      } catch (error) { return { ok: false, error: error instanceof Error ? error.message : '应用操作失败。' }; }
    });
  }
  const launch = async () => {
    window = secureWindow('business', join(__dirname, 'preload.cjs'), null, () => manifest,
      request => serveAsset(join(root, 'dist'), request.url, [manifest]));
    window.on('closed', () => { window = undefined; }); await window.loadURL(SHELL_URL);
  };
  app.whenReady().then(async () => {
    await mkdir(profile, { recursive: true }); if (closing) return;
    handle('host:info', () => manifest); handle('host:tools', () => [manifest]);
    handle('host:storage', (toolId: string, request: StorageRequest) => {
      if (toolId !== manifest.id || !manifest.capabilities.includes('storage')) throw new Error('应用没有此存储权限。');
      database ??= new ToolStorage(join(profile, 'data/records.sqlite')); return database.execute(manifest.id, request);
    });
    handle('host:service', (toolId: string, service: string, method: string, input: Json) => {
      if (toolId !== manifest.id) throw new Error('应用身份无效。'); return services(service, method, input);
    });
    for (const channel of ['export', 'reload-project-view', 'model-settings', 'project-action', 'windows', 'workspace', 'development', 'build', 'git']) handle(`host:${channel}`, unavailable);
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      ...(process.platform === 'darwin' ? [{ label: manifest.name, role: 'appMenu' as const }] : []),
      { role: 'fileMenu' }, { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' },
    ]));
    await launch();
    app.on('activate', () => { if (window) window.focus(); else if (!closing) void launch(); });
    app.on('second-instance', () => { if (window?.isMinimized()) window.restore(); window?.focus(); });
  }).catch(error => { dialog.showErrorBox(`${manifest.name} 无法启动`, String(error)); app.quit(); });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => { closing = true; database?.close(); database = undefined; });
}
