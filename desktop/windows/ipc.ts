import { ipcMain } from 'electron';
import type { AppManifest } from '../../shared/contracts';
import { ProjectWindows } from './controller';

export function registerWindowIpc(windows: ProjectWindows, manifest: AppManifest): void {
  function handle(channel: string, handler: (context: ReturnType<ProjectWindows['trust']>, ...args: any[]) => unknown) {
    ipcMain.handle(channel, async (event, ...args) => {
      try { return { ok: true, result: await handler(windows.trust(event), ...args) }; }
      catch (error) { return { ok: false, error: error instanceof Error ? error.message : '应用操作失败，请重试。' }; }
    });
  }
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
  handle('host:versions', async (context, request) => {
    context.assertAvailable(); if (!context.versions) throw new Error('当前应用未启用版本管理。');
    const result = await context.versions.execute(request); await windows.updateTitle(context); return result;
  });
  handle('host:storage', (context, toolId, request, contextId) => context.storage(toolId, request, contextId));
  handle('host:service', (context, toolId, service, method, input, contextId) => context.service(toolId, service, method, input, contextId));
}
