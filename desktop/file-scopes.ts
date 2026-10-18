import { dialog, ipcMain } from 'electron';
import type { BrowserWindow } from 'electron';
import type { ConversationService } from '../src/conversation/service.js';
import { ConversationError } from '../src/conversation/state.js';
import { FileScopeError } from '../src/files/scope-types.js';
import type { DirectoryPicker, FileGrantOptions } from '../src/files/scope-types.js';
import type { ModelConnectionConfig } from '../src/model/types.js';
import { fileScopeCommand } from '../src/files/scope-command.js';
import type { DesktopDeviceAccess } from './device-access.js';

export function desktopDirectoryPicker(config: ModelConnectionConfig): DirectoryPicker {
  return async (_sessionId, options: FileGrantOptions) => {
    const reply = await dialog.showOpenDialog({ properties: ['openDirectory'],
      title: options.mode === 'read' ? '允许当前会话读取此目录' : '允许当前会话读取，并经逐次确认修改此目录',
      message: `模型：${config.model}；服务：${new URL(config.baseUrl).origin}。${options.remember ? '记住目录范围。' : '退出后撤销目录范围。'}` });
    return reply.canceled ? undefined : reply.filePaths[0];
  };
}
/** The renderer requests a native chooser; it can never submit a grant path. */
export function registerFileScopeIpc(window: BrowserWindow, rendererUrl: string, service: ConversationService, device?: DesktopDeviceAccess): () => void {
  ipcMain.handle('dreamedge:file-scopes', async (event, value: unknown) => {
    if (event.sender !== window.webContents || event.senderFrame !== event.sender.mainFrame || event.senderFrame.url !== rendererUrl) {
      return { ok: false, error: { code: 'INVALID_SENDER', message: '目录授权页面连接无效。' } };
    }
    try {
      const command = fileScopeCommand(value);
      if (command.type !== 'snapshot' && service.fileScopes.overview(command.sessionId).device?.mode === 'account') {
        throw new FileScopeError('FILE_SCOPE_DENIED', '账户权限模式不使用目录授权命令。');
      }
      if (command.type === 'device') {
        service.getSnapshot(command.sessionId);
        if (!device) throw new FileScopeError('FILE_SCOPE_DENIED', '宿主未提供整机访问模式。');
        return { ok: true, data: await device.set(service, command.enabled) };
      }
      if (command.type === 'snapshot') return { ok: true, data: service.fileScopes.snapshot(command.sessionId) };
      if (command.type === 'choose') return { ok: true, data: await service.fileScopes.chooseDirectory(command.sessionId, command.options) };
      service.fileScopes.revoke(command.sessionId, command.grantId); return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof FileScopeError || error instanceof ConversationError
        ? { code: error.code, message: error.message } : { code: 'FILE_IO_FAILED', message: '无法完成目录授权操作。' } };
    }
  });
  return () => ipcMain.removeHandler('dreamedge:file-scopes');
}
