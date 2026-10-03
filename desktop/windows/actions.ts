import { app, dialog, shell, type BrowserWindow } from 'electron';
import { basename } from 'node:path';
import type { ProjectAction, ProjectWindow } from '../../shared/contracts';
import { ProjectWindows } from './controller';
import type { WindowContext } from './context';

export class ProjectActions {
  private readonly pending = new Set<number>();
  constructor(private readonly windows: ProjectWindows) {}
  async execute(input: unknown, parent: BrowserWindow | null, context?: WindowContext): Promise<ProjectWindow | null> {
    if (input !== 'new' && input !== 'createProject' && input !== 'openProject' && input !== 'revealProject') throw new Error('不支持的工程操作。');
    const operation: ProjectAction = input;
    const key = parent?.id ?? 0;
    if (this.pending.has(key)) throw new Error('工程操作正在进行，请稍后再试。');
    this.pending.add(key);
    const assertParent = () => {
      if (context) this.windows.nativeWindow(context);
      if (parent?.isDestroyed()) throw new Error('开发窗口已关闭。');
    };
    try {
      assertParent();
      if (operation === 'revealProject') {
        const info = await context?.info(); if (!info?.project) throw new Error('当前没有打开的工程。');
        shell.showItemInFolder(info.project.rootDirectory); return info;
      }
      if (operation === 'new') return await this.windows.openFromAction({ operation }, parent);
      if (operation === 'createProject') {
        const options: Electron.SaveDialogOptions = { title: '新建工程', buttonLabel: '创建工程',
          defaultPath: app.getPath('documents'), nameFieldLabel: '新工程文件夹名称：', showsTagField: false,
          message: '请填写工程名称，位置选择其父目录。名称会同时用于新文件夹、窗口标题和初始应用名称。' };
        const chosen = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options);
        assertParent();
        if (chosen.canceled || !chosen.filePath) return null;
        return await this.windows.openFromAction({ operation, directory: chosen.filePath, name: basename(chosen.filePath) }, parent);
      }
      const options: Electron.OpenDialogOptions = { title: '打开工程', buttonLabel: '打开工程', properties: ['openDirectory'],
        message: '选择之前创建的 DreamEdge 工程文件夹。' };
      const chosen = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
      assertParent();
      if (chosen.canceled || !chosen.filePaths[0]) return null;
      return await this.windows.openFromAction({ operation, directory: chosen.filePaths[0] }, parent);
    } catch (error) { throw new Error(projectActionError(error)); }
    finally { this.pending.delete(key); }
  }
}

export function projectActionError(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === 'EEXIST' ? '该位置已经存在文件或文件夹，请使用一个新的工程名称。'
    : code === 'ENOENT' ? '无法打开这个位置。打开工程时，请选择之前创建的工程文件夹。'
    : error instanceof Error ? error.message : '工程操作失败，请重试。';
}
