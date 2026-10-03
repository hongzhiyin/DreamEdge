import { app, dialog, protocol } from 'electron';
import { dirname, join, resolve } from 'node:path';
import { loadApplication, applicationDataDirectory } from './project';
import { mkdir } from 'node:fs/promises';
import { workerExportEngine } from './export/runner';
import { workerEngine } from './build/runner';
import { ProjectWindows } from './windows/controller';
import { registerWindowIpc } from './windows/ipc';
import { installProjectMenu } from './windows/menu';
import { ProjectActions } from './windows/actions';

export function startApp(): void {
  const root = app.getAppPath(); const manifest = loadApplication(root);
  const profile = process.env.DREAMEDGE_DATA_DIR ? resolve(process.env.DREAMEDGE_DATA_DIR) : applicationDataDirectory(app.getPath('appData'), manifest);
  app.setName(manifest.name); app.setPath('userData', profile); app.setAppUserModelId(manifest.appId);
  if (!app.requestSingleInstanceLock()) { app.quit(); return; }
  protocol.registerSchemesAsPrivileged(['dreamedge', 'dreamedge-preview'].map(scheme => ({ scheme, privileges: { standard: true, secure: true, supportFetchAPI: true } })));
  const frameworkRoot = app.isPackaged ? (process.platform === 'darwin' ? resolve(dirname(app.getPath('exe')), '../..') : dirname(app.getPath('exe'))) : root;
  let windows: ProjectWindows | undefined;
  let closing = false;
  app.whenReady().then(async () => {
    await mkdir(profile, { recursive: true });
    if (closing) return;
    windows = new ProjectWindows(manifest, root, profile, frameworkRoot, join(__dirname, 'preload.cjs'), undefined,
      workerEngine(join(__dirname, 'build-worker.cjs')),
      workerExportEngine(join(__dirname, 'export-worker.cjs'), resolve(dirname(app.getPath('exe')), '../..'), process.versions.electron),
      { runtime: join(root, 'dist/framework/runtime'), frameworkAppId: manifest.appId });
    const actions = new ProjectActions(windows);
    registerWindowIpc(windows, manifest, actions);
    installProjectMenu(actions, manifest.name, manifest.capabilities.includes('workspace'));
    await windows.restore();
    app.on('activate', () => { void windows?.activate().catch(() => {}); });
    app.on('second-instance', () => { void windows?.activate().catch(() => {}); });
  }).catch(error => { dialog.showErrorBox(`${manifest.name} 无法启动`, String(error)); app.quit(); });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', event => {
    if (closing) return;
    event.preventDefault(); closing = true;
    void Promise.all([windows?.shutdown()]).finally(() => app.quit());
  });
}
