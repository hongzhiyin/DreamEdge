import { ipcMain, dialog, shell } from 'electron';
import type { AppManifest } from '../../shared/contracts';
import { ProjectWindows } from './controller';
import { ProjectActions } from './actions';

export function registerWindowIpc(windows: ProjectWindows, manifest: AppManifest, actions: ProjectActions): void {
  function handle(channel: string, handler: (context: ReturnType<ProjectWindows['trust']>, ...args: any[]) => unknown) {
    ipcMain.handle(channel, async (event, ...args) => {
      try { return { ok: true, result: await handler(windows.trust(event), ...args) }; }
      catch (error) { return { ok: false, error: error instanceof Error ? error.message : '应用操作失败，请重试。' }; }
    });
  }
  handle('host:export', async (context, request) => {
    context.assertAvailable(); if (!context.exports) throw new Error('当前应用未启用 App 导出。');
    if (request?.operation === 'start' && request.directory === undefined) {
      const status = await context.workspace!.execute({ operation: 'current' });
      const definition = 'project' in status ? status.project?.definition : undefined;
      const choice = await dialog.showSaveDialog(windows.nativeWindow(context), { title: '导出独立业务 App', buttonLabel: '导出',
        defaultPath: `${definition?.appName ?? definition?.name ?? 'App'}-导出`, properties: ['createDirectory'] });
      if (choice.canceled || !choice.filePath) return null;
      return context.exports.execute({ ...request, directory: choice.filePath });
    }
    if (request?.operation === 'reveal') {
      const record = await context.exports.execute({ ...request, operation: 'get' });
      if (!record || !('status' in record) || record.status !== 'succeeded') throw new Error('只能查看成功的导出。');
      shell.showItemInFolder(record.directory); return { revealed: true };
    }
    return context.exports.execute(request);
  });
  handle('host:reload-project-view', context => context.reloadDisplay());
  handle('host:model-settings', (context, request) => {
    context.assertAvailable(); if (!context.workspace) throw new Error('当前应用未启用模型配置。');
    return context.modelSettings!.execute(request);
  });
  handle('host:project-action', (context, action) => actions.execute(action, windows.nativeWindow(context), context));
  handle('host:info', () => manifest);
  handle('host:tools', context => context.tools());
  handle('host:windows', (context, request) => windows.execute(context, request));
  handle('host:workspace', async (context, request) => {
    const result = await context.executeWorkspace(request); await windows.updateTitle(context); return result;
  });
  handle('host:development', (context, request) => {
    context.assertAvailable(); if (!context.development) throw new Error('当前应用未启用模型会话。'); return context.development.execute(request);
  });
  handle('host:build', (context, request) => {
    context.assertAvailable(); if (!context.builds) throw new Error('当前应用未启用候选构建。'); return context.builds.execute(request);
  });
  handle('host:git', async (context, request) => {
    context.assertAvailable(); if (!context.git) throw new Error('当前应用未启用版本管理。');
    const result = await context.git.execute(request); await windows.updateTitle(context); return result;
  });
  handle('host:storage', (context, toolId, request, contextId) => context.storage(toolId, request, contextId));
  handle('host:service', (context, toolId, service, method, input, contextId) => context.service(toolId, service, method, input, contextId));
}
