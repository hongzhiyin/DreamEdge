import { app, BrowserWindow, dialog, Menu, type MenuItemConstructorOptions } from 'electron';
import { basename, join } from 'node:path';
import { ProjectWindows } from './controller';

export function installProjectMenu(windows: ProjectWindows, applicationName: string, enabled: boolean): void {
  let busy = false;
  async function run(operation: 'new' | 'createProject' | 'openProject'): Promise<void> {
    if (busy) return;
    busy = true; const parent = BrowserWindow.getFocusedWindow();
    try {
      if (operation === 'new') { await windows.openFromMenu({ operation }, parent); return; }
      if (operation === 'createProject') {
        const options: Electron.SaveDialogOptions = { title: '新建工程', buttonLabel: '创建工程',
          defaultPath: join(app.getPath('documents'), 'DreamEdge工程'), nameFieldLabel: '工程名称：', showsTagField: false,
          message: '输入工程名称并选择存放位置，将创建同名工程文件夹。' };
        const chosen = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options);
        if (!chosen.canceled && chosen.filePath) await windows.openFromMenu({ operation, directory: chosen.filePath, name: basename(chosen.filePath) }, parent);
      } else {
        const options: Electron.OpenDialogOptions = { title: '打开工程', buttonLabel: '打开工程', properties: ['openDirectory'],
          message: '选择之前创建的 DreamEdge 工程文件夹。' };
        const chosen = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
        if (!chosen.canceled && chosen.filePaths[0]) await windows.openFromMenu({ operation, directory: chosen.filePaths[0] }, parent);
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const message = code === 'EEXIST' ? '该位置已经存在文件或文件夹，请使用一个新的工程名称。'
        : code === 'ENOENT' ? '无法打开这个位置。打开工程时，请选择之前创建的工程文件夹。'
        : error instanceof Error ? error.message : '工程操作失败，请重试。';
      const options: Electron.MessageBoxOptions = { type: 'error', title: '工程操作未完成', message, buttons: ['知道了'] };
      if (parent && !parent.isDestroyed()) await dialog.showMessageBox(parent, options); else await dialog.showMessageBox(options);
    } finally { busy = false; }
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
