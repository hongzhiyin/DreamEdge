import { BrowserWindow, dialog, Menu, type MenuItemConstructorOptions } from 'electron';
import type { ProjectAction } from '../../shared/contracts';
import { ProjectActions, projectActionError } from './actions';

export function installProjectMenu(actions: ProjectActions, applicationName: string, enabled: boolean): void {
  async function run(operation: ProjectAction): Promise<void> {
    const parent = BrowserWindow.getFocusedWindow();
    try { await actions.execute(operation, parent); }
    catch (error) {
      const options: Electron.MessageBoxOptions = { type: 'error', title: '工程操作未完成',
        message: projectActionError(error), buttons: ['知道了'] };
      if (parent && !parent.isDestroyed()) await dialog.showMessageBox(parent, options); else await dialog.showMessageBox(options);
    }
  }
  const commands: MenuItemConstructorOptions[] = enabled ? [
    { id: 'project-new', label: '新建工程…', accelerator: 'CmdOrCtrl+Shift+N', click: () => { void run('createProject'); } },
    { id: 'project-open', label: '打开工程…', accelerator: 'CmdOrCtrl+O', click: () => { void run('openProject'); } },
    { id: 'project-window', label: '新窗口', accelerator: 'CmdOrCtrl+N', click: () => { void run('new'); } },
    { type: 'separator' },
  ] : [];
  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin' ? [{ label: applicationName, role: 'appMenu' as const }] : []),
    { label: '文件', submenu: [...commands, { role: 'close', label: '关闭窗口' }, ...(process.platform === 'darwin' ? [] : [{ role: 'quit' as const, label: '退出' }])] },
    { role: 'editMenu', label: '编辑' },
    { role: 'viewMenu', label: '视图' },
    { role: 'windowMenu', label: '窗口' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
