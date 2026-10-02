import { app, BrowserWindow, dialog, ipcMain, protocol, session } from 'electron';
import { dirname, join, resolve } from 'node:path';
import { serveAsset } from './assets';
import { ToolStorage } from './storage';
import { loadApplication, applicationDataDirectory } from './project';
import { createServices } from './services';
import { SHELL_URL } from '../shared/contracts';
import { WorkspaceApi } from './workspace/api';
import { DevelopmentApi } from './development/api';
import { configuredModel } from './development/responses';
import { CandidateBuildApi } from './build/api';
import { workerEngine } from './build/runner';
import { CandidatePreviews } from './build/preview';
export function startApp(): void {
  const root = app.getAppPath();
  const manifest = loadApplication(root);
  const catalog = [manifest];
  const dataDirectory = process.env.DREAMEDGE_DATA_DIR
    ? resolve(process.env.DREAMEDGE_DATA_DIR) : applicationDataDirectory(app.getPath('appData'), manifest);
  app.setName(manifest.name);
  app.setPath('userData', dataDirectory);
  app.setAppUserModelId(manifest.appId);
  const services = createServices(manifest, root, dataDirectory);
  const frameworkRoot = app.isPackaged ? (process.platform === 'darwin'
    ? resolve(dirname(app.getPath('exe')), '../..') : dirname(app.getPath('exe'))) : root;
  const workspace = manifest.capabilities.includes('workspace') ? new WorkspaceApi(dataDirectory, frameworkRoot) : undefined;
  const development = workspace ? new DevelopmentApi(workspace, configuredModel(process.env)) : undefined;
  const previews = new CandidatePreviews();
  const builds = workspace ? new CandidateBuildApi(workspace, workerEngine(join(__dirname, 'build-worker.cjs')), (project, record) => previews.open(project, record)) : undefined;
  protocol.registerSchemesAsPrivileged(['dreamedge', 'dreamedge-preview'].map(scheme => ({ scheme, privileges: { standard: true, secure: true, supportFetchAPI: true } })));
  let storage: ToolStorage | undefined;
  function createWindow() {
    const window = new BrowserWindow({
      title: manifest.name, width: 1180, height: 850, minWidth: 920, minHeight: 650,
      backgroundColor: '#f7f8f5', autoHideMenuBar: true,
      webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true,
        sandbox: true, nodeIntegration: false, webSecurity: true },
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.webContents.on('will-frame-navigate', event => {
      if (!event.isMainFrame && event.url !== `dreamedge://${manifest.id}/${manifest.entry}`) event.preventDefault();
    });
    void window.loadURL(SHELL_URL);
  }
  app.whenReady().then(() => {
    storage = new ToolStorage(join(dataDirectory, 'data', 'records.sqlite'));
    protocol.handle('dreamedge', request => serveAsset(join(root, 'dist'), request.url, catalog));
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    function trust(event: Electron.IpcMainInvokeEvent, toolId?: unknown) {
      if (event.senderFrame !== event.sender.mainFrame || event.senderFrame?.url !== SHELL_URL
          || (toolId !== undefined && toolId !== manifest.id)) throw new Error('应用调用来源无效。');
    }
    function handle(channel: string, handler: (event: Electron.IpcMainInvokeEvent, ...arguments_: any[]) => unknown) {
      ipcMain.handle(channel, async (event, ...arguments_) => {
        try { return { ok: true, result: await handler(event, ...arguments_) }; }
        catch (error) { return { ok: false, error: error instanceof Error ? error.message : '应用操作失败，请重试。' }; }
      });
    }
    handle('host:info', event => { trust(event); return manifest; });
    handle('host:tools', event => { trust(event); return catalog; });
    handle('host:workspace', (event, request) => {
      trust(event);
      if (!workspace) throw new Error('当前应用未启用工程开发能力。');
      return workspace.execute(request);
    });
    handle('host:development', (event, request) => {
      trust(event);
      if (!development) throw new Error('当前应用未启用工程开发能力。');
      return development.execute(request);
    });
    handle('host:build', (event, request) => {
      trust(event);
      if (!builds) throw new Error('当前应用未启用工程开发能力。');
      return builds.execute(request);
    });
    handle('host:storage', (event, toolId, request) => {
      if (toolId !== manifest.id) throw new Error('应用身份无效。');
      trust(event, toolId);
      if (!manifest.capabilities.includes('storage')) throw new Error('应用没有存储权限。');
      return storage!.execute(manifest.id, request);
    });
    handle('host:service', (event, toolId, service, method, input) => {
      if (toolId !== manifest.id) throw new Error('应用身份无效。');
      trust(event, toolId); return services(service, method, input);
    });
    createWindow();
    app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
  }).catch(error => { dialog.showErrorBox(`${manifest.name} 无法启动`, String(error)); app.quit(); });
  app.on('window-all-closed', () => app.quit());
  app.on('will-quit', () => storage?.close());
  let closing = false;
  app.on('before-quit', event => {
    if (!development || closing) return;
    event.preventDefault(); closing = true;
    previews.close();
    void Promise.all([development.dispose(), builds?.dispose()]).finally(() => app.quit());
  });
}
