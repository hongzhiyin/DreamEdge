import { BrowserWindow, session } from 'electron';
import { randomUUID } from 'node:crypto';
import type { CandidateBuild, WorkspaceProject } from '../../shared/contracts';
import { servePreview } from './preview-assets';

export class CandidatePreviews {
  private readonly windows = new Map<string, { window: BrowserWindow; ready: Promise<void> }>();
  async open(project: WorkspaceProject, record: CandidateBuild): Promise<void> {
    const existing = this.windows.get(record.id);
    if (existing) { existing.window.focus(); return existing.ready; }
    if (this.windows.size >= 4) throw new Error('最多同时打开四个候选预览，请先关闭一个。');
    const url = record.previewUrl!;
    const origin = new URL(url).origin;
    const previewSession = session.fromPartition(`dreamedge-preview-${randomUUID()}`, { cache: false });
    previewSession.protocol.handle('dreamedge-preview', request => servePreview(project, record, request.url));
    previewSession.webRequest.onBeforeRequest((details, callback) => {
      const target = new URL(details.url);
      callback({ cancel: target.protocol !== 'dreamedge-preview:' || target.origin !== origin || target.hostname !== new URL(url).hostname });
    });
    previewSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    previewSession.setPermissionCheckHandler(() => false);
    previewSession.on('will-download', event => event.preventDefault());
    const window = new BrowserWindow({ title: `${project.definition.name} · 候选预览`, width: 960, height: 720,
      webPreferences: { session: previewSession, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true } });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.webContents.on('will-frame-navigate', event => event.preventDefault());
    window.webContents.on('will-attach-webview', event => event.preventDefault());
    window.on('closed', () => { this.windows.delete(record.id); void previewSession.clearStorageData(); });
    let timer: ReturnType<typeof setTimeout>;
    const ready = Promise.race([window.loadURL(url), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('候选预览加载超时。')), 10000);
    })]).catch(() => { window.destroy(); throw new Error('候选预览无法加载，请重新构建。'); }).finally(() => clearTimeout(timer));
    this.windows.set(record.id, { window, ready });
    await ready;
  }
  close(): void { for (const { window } of this.windows.values()) window.destroy(); }
}
