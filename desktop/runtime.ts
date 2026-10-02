import { app, dialog, protocol } from 'electron';
import { dirname, join, resolve } from 'node:path';
import { loadApplication, applicationDataDirectory } from './project';
import { configuredModel } from './development/responses';
import { workerEngine } from './build/runner';
import { ProjectWindows } from './windows/controller';
import { registerWindowIpc } from './windows/ipc';

export function startApp(): void {
  const root = app.getAppPath(); const manifest = loadApplication(root);
  const profile = process.env.DREAMEDGE_DATA_DIR ? resolve(process.env.DREAMEDGE_DATA_DIR) : applicationDataDirectory(app.getPath('appData'), manifest);
  app.setName(manifest.name); app.setPath('userData', profile); app.setAppUserModelId(manifest.appId);
  if (!app.requestSingleInstanceLock()) { app.quit(); return; }
  protocol.registerSchemesAsPrivileged(['dreamedge', 'dreamedge-preview'].map(scheme => ({ scheme, privileges: { standard: true, secure: true, supportFetchAPI: true } })));
  const frameworkRoot = app.isPackaged ? (process.platform === 'darwin' ? resolve(dirname(app.getPath('exe')), '../..') : dirname(app.getPath('exe'))) : root;
  const windows = new ProjectWindows(manifest, root, profile, frameworkRoot, join(__dirname, 'preload.cjs'),
    configuredModel(process.env), workerEngine(join(__dirname, 'build-worker.cjs')));
  app.whenReady().then(async () => {
    registerWindowIpc(windows, manifest); await windows.restore();
    app.on('activate', () => { void windows.activate().catch(() => {}); });
    app.on('second-instance', () => { void windows.activate().catch(() => {}); });
  }).catch(error => { dialog.showErrorBox(`${manifest.name} 无法启动`, String(error)); app.quit(); });
  app.on('window-all-closed', () => app.quit());
  let closing = false;
  app.on('before-quit', event => {
    if (closing) return;
    event.preventDefault(); closing = true;
    void windows.shutdown().finally(() => app.quit());
  });
}
