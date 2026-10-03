import { BrowserWindow } from 'electron';
import type { AppManifest, ProjectWindow, WindowRequest, WindowResult } from '../../shared/contracts';
import { SHELL_URL } from '../../shared/contracts';
import { WorkspaceRegistry } from '../workspace/registry';
import { CandidatePreviews } from '../build/preview';
import type { BuildEngine } from '../build/types';
import type { ModelProvider } from '../development/model';
import { WindowContext } from './context';
import { Capacity } from './capacity';
import { WindowState, ProjectAlreadyOpen, type WindowRecord } from './state';
import type { ExportEngine, ExportResources } from '../export/types';
import { createHostWindow } from './window';

interface LiveWindow { context: WindowContext; window: BrowserWindow; closing: boolean }
export class ProjectWindows {
  private readonly windows = new Map<string, LiveWindow>();
  private readonly catalog: WorkspaceRegistry;
  private readonly state: WindowState;
  private readonly buildCapacity = new Capacity(2, '当前最多同时运行两个候选构建。');
  private readonly previewCapacity = new Capacity(4, '最多同时打开四个候选预览。');
  private quitting = false;
  constructor(private readonly manifest: AppManifest, private readonly root: string, private readonly profile: string,
    private readonly frameworkRoot: string, private readonly preload: string, private readonly provider: ModelProvider | undefined, private readonly engine: BuildEngine, private readonly exportEngine?: ExportEngine, private readonly exportResources?: ExportResources) {
    this.catalog = new WorkspaceRegistry(profile); this.state = new WindowState(profile);
    void this.catalog.ready.catch(() => {}); void this.state.ready.catch(() => {});
  }
  async restore(): Promise<void> {
    await Promise.all([this.catalog.ready, this.state.ready]);
    const all = await this.state.records(); const records = all.filter(record => record.open);
    if (!records.length) records.push(await this.state.allocate(all.length ? null : await this.catalog.load()));
    for (const record of records) await this.launch(record);
  }
  private context(record: WindowRecord): WindowContext {
    const previews = new CandidatePreviews(this.previewCapacity);
    return new WindowContext({ id: record.id, manifest: this.manifest, root: this.root, profile: this.profile,
      frameworkRoot: this.frameworkRoot, catalog: this.catalog, windows: this.state, provider: this.provider, engine: this.engine,
      exportEngine: this.exportEngine, exportResources: this.exportResources,
      buildCapacity: this.buildCapacity, openPreview: (project, build) => previews.open(project, build), closePreviews: () => previews.close(),
      modelSettingsChanged: () => { const live = this.windows.get(record.id); if (live) live.window.webContents.send('host:model-settings-changed'); },
      changed: () => { const live = this.windows.get(record.id); if (live) live.window.webContents.send('host:context-changed'); } });
  }
  private async launch(record: WindowRecord, context = this.context(record)): Promise<ProjectWindow> {
    await context.ready();
    const window = createHostWindow(context, record.id, this.root, this.preload, this.manifest.id, record.bounds);
    const live = { context, window, closing: false }; this.windows.set(record.id, live);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const saveBounds = () => { if (!window.isDestroyed()) void this.state.bounds(record.id, window.getNormalBounds()).catch(() => {}); };
    const schedule = () => { clearTimeout(timer); timer = setTimeout(saveBounds, 200); };
    window.on('move', schedule); window.on('resize', schedule);
    window.on('close', event => {
      if (this.quitting) return;
      event.preventDefault();
      if (live.closing) return;
      live.closing = true; clearTimeout(timer);
      void (async () => {
        await this.state.bounds(record.id, window.getNormalBounds());
        await context.dispose(); await this.state.close(record.id); window.destroy();
      })().catch(() => { live.closing = false; });
    });
    window.on('closed', () => { clearTimeout(timer); this.windows.delete(record.id); });
    await this.updateTitle(context); await window.loadURL(SHELL_URL);
    return context.info();
  }
  trust(event: Electron.IpcMainInvokeEvent): WindowContext {
    if (event.senderFrame !== event.sender.mainFrame || event.senderFrame?.url !== SHELL_URL) throw new Error('应用调用来源无效。');
    const live = [...this.windows.values()].find(live => live.window.webContents === event.sender);
    if (!live || live.closing || this.quitting) throw new Error('开发窗口不存在或正在关闭。');
    return live.context;
  }
  nativeWindow(context: WindowContext): BrowserWindow {
    const live = [...this.windows.values()].find(live => live.context === context);
    if (!live || live.closing || this.quitting || live.window.isDestroyed()) throw new Error('开发窗口不存在或正在关闭。');
    context.assertAvailable();
    if (!context.workspace) throw new Error('当前应用未启用工程开发能力。');
    return live.window;
  }
  async updateTitle(context: WindowContext): Promise<void> {
    const info = await context.info(); const live = this.windows.get(info.id);
    if (live && !live.window.isDestroyed()) live.window.setTitle(info.project ? `${this.manifest.name} · ${info.project.name}` : this.manifest.name);
  }
  private async focus(id: string): Promise<ProjectWindow> {
    const live = this.windows.get(id);
    if (!live || live.closing) throw new Error('开发窗口不存在。');
    if (live.window.isMinimized()) live.window.restore(); live.window.focus(); return live.context.info();
  }
  async execute(context: WindowContext, input: unknown): Promise<WindowResult> {
    if (!context.workspace) throw new Error('当前应用未启用工程开发能力。');
    const request = structuredClone(input) as WindowRequest;
    if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('窗口请求无效。');
    if (request.operation === 'current') return context.info();
    if (request.operation === 'list') return Promise.all([...this.windows.values()].filter(live => !live.closing).map(live => live.context.info()));
    if (request.operation === 'focus') return this.focus(request.windowId);
    if (!['new', 'createProject', 'openProject'].includes(request.operation)) throw new Error('不支持的窗口操作。');
    return this.open(request as Extract<WindowRequest, { operation: 'new' | 'createProject' | 'openProject' }>);
  }
  async open(request: Extract<WindowRequest, { operation: 'new' | 'createProject' | 'openProject' }>): Promise<ProjectWindow> {
    if (this.quitting || !this.manifest.capabilities.includes('workspace')) throw new Error('当前应用无法打开开发窗口。');
    const closed = request.operation === 'openProject' ? (await this.state.records()).find(window => !window.open && window.project?.root === request.directory) : undefined;
    const record = await this.state.allocate(null, closed?.id); const next = this.context(record);
    try {
      await next.ready();
      if (request.operation === 'createProject') await next.executeWorkspace({ operation: 'create', directory: request.directory, name: request.name });
      if (request.operation === 'openProject') await next.executeWorkspace({ operation: 'open', directory: request.directory });
      return await this.launch(record, next);
    } catch (error) {
      await next.dispose();
      if (closed) await this.state.close(record.id); else await this.state.discard(record.id);
      if (error instanceof ProjectAlreadyOpen) return this.focus(error.windowId);
      throw error;
    }
  }
  async openFromAction(request: Extract<WindowRequest, { operation: 'new' | 'createProject' | 'openProject' }>, parent: BrowserWindow | null): Promise<ProjectWindow> {
    const live = [...this.windows.values()].find(live => live.window === parent && !live.closing);
    if (live && request.operation !== 'new') {
      const info = await live.context.info();
      if (!info.project && !info.recoveryError) {
        try {
          await live.context.executeWorkspace(request.operation === 'createProject'
            ? { operation: 'create', directory: request.directory, name: request.name }
            : { operation: 'open', directory: request.directory });
          await this.updateTitle(live.context); return live.context.info();
        } catch (error) { if (error instanceof ProjectAlreadyOpen) return this.focus(error.windowId); throw error; }
      }
    }
    return this.open(request);
  }
  async activate(): Promise<void> {
    const live = [...this.windows.entries()].find(([, live]) => !live.closing);
    if (live) { await this.focus(live[0]); return; }
    if (!this.quitting) await this.launch(await this.state.allocate());
  }
  async shutdown(): Promise<void> {
    this.quitting = true;
    await Promise.all([...this.windows.entries()].map(async ([id, { context, window }]) => {
      if (!window.isDestroyed()) await this.state.bounds(id, window.getNormalBounds());
      await context.dispose();
    }));
  }
}
