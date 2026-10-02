import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { AppManifest, Json, ProjectWindow, StorageRequest, WorkspaceProject, WorkspaceRequest, WorkspaceResult } from '../../shared/contracts';
import { WorkspaceApi } from '../workspace/api';
import { WorkspaceRegistry } from '../workspace/registry';
import { ToolStorage } from '../storage';
import { createServices } from '../services';
import { DevelopmentApi } from '../development/api';
import type { ModelProvider } from '../development/model';
import { CandidateBuildApi, type PreviewOpener } from '../build/api';
import type { BuildEngine } from '../build/types';
import { VersionsApi } from '../versions/api';
import { WindowState } from './state';
import { windowSelection } from './selection';
import { Capacity } from './capacity';
import { SavedProjectDisplay } from '../display/current';

export interface ContextOptions {
  id: string; manifest: AppManifest; root: string; profile: string; frameworkRoot: string;
  catalog: WorkspaceRegistry; windows: WindowState; provider: ModelProvider; engine: BuildEngine;
  openPreview: PreviewOpener; buildCapacity: Capacity; changed: () => void; closePreviews: () => void;
}
export class WindowContext {
  readonly workspace?: WorkspaceApi;
  private readonly display?: SavedProjectDisplay;
  development?: DevelopmentApi;
  builds?: CandidateBuildApi;
  versions?: VersionsApi;
  private contextId = randomUUID();
  private selected: WorkspaceProject | null = null;
  private transitioning = false;
  private disposed = false;
  private transition: Promise<WorkspaceResult> | null = null;
  private readonly databases = new Map<string, ToolStorage>();
  private readonly services = new Map<string, ReturnType<typeof createServices>>();
  constructor(private readonly options: ContextOptions) {
    if (options.manifest.capabilities.includes('workspace')) {
      this.workspace = new WorkspaceApi(options.profile, options.frameworkRoot,
        windowSelection(options.id, options.windows, options.catalog, project => {
          this.selected = project; this.contextId = randomUUID(); options.changed();
        }));
      this.display = new SavedProjectDisplay(this.workspace, options.engine, options.buildCapacity, () => {
        this.contextId = randomUUID(); options.changed();
      });
      this.startTasks();
    }
  }
  async ready(): Promise<void> {
    if (this.workspace) {
      const status = await this.workspace.execute({ operation: 'current' });
      this.selected = 'project' in status ? status.project : null;
      this.display?.refresh();
    }
  }
  private startTasks(): void {
    if (!this.workspace) return;
    this.development = new DevelopmentApi(this.workspace, this.options.provider);
    this.builds = new CandidateBuildApi(this.workspace, this.options.engine, this.options.openPreview, 300000, this.options.buildCapacity);
    this.versions = new VersionsApi(this.workspace, this.options.profile, undefined, 30000, () => { if (!this.disposed && !this.transitioning) this.display?.refresh(); });
  }
  assertAvailable(): void {
    if (this.disposed || this.transitioning) throw new Error('开发窗口正在切换工程或关闭，请稍后再试。');
  }
  tools(): AppManifest[] {
    const { manifest, id } = this.options;
    const logicalId = this.workspace ? (this.selected ? `p${this.selected.definition.id.replaceAll('-', '')}` : `blank-${id}`) : manifest.id;
    return [{ ...manifest, id: logicalId, appId: this.selected?.definition.appId ?? manifest.appId,
      version: this.selected?.definition.version ?? manifest.version, contextId: this.contextId,
      ...(this.selected ? { entry: this.display?.entry ?? manifest.entry, projectView: this.display?.status ?? { status: 'loading' as const, error: null } } : {}) }];
  }
  async info(): Promise<ProjectWindow> {
    const status = this.workspace ? await this.workspace.execute({ operation: 'current' }) : { project: null, recoveryError: null };
    const project = 'project' in status ? status.project : null;
    this.selected = project;
    return { id: this.options.id, project: project ? { id: project.definition.id, name: project.definition.name, rootDirectory: project.rootDirectory } : null,
      recoveryError: 'recoveryError' in status ? status.recoveryError : null };
  }
  async executeWorkspace(request: WorkspaceRequest): Promise<WorkspaceResult> {
    this.assertAvailable();
    if (!this.workspace) throw new Error('当前应用未启用工程开发能力。');
    const transition = ['create', 'open', 'close'].includes(request?.operation);
    if (!transition) {
      const result = await this.workspace.execute(request);
      if (request.operation === 'save') this.display?.refresh();
      return result;
    }
    this.transitioning = true;
    const result = (async () => {
      try {
        await this.stopTasks(); await this.display?.stop(); this.options.closePreviews();
        if (this.disposed) throw new Error('开发窗口正在关闭。');
        return await this.workspace!.execute(request);
      } finally { if (!this.disposed) this.startTasks(); this.transitioning = false; if (!this.disposed) this.display?.refresh(); }
    })();
    this.transition = result;
    try { return await result; } finally { this.transition = null; }
  }
  reloadDisplay(): void { this.assertAvailable(); if (!this.display) throw new Error('当前应用没有工程显示能力。'); this.display.refresh(); }
  serveProject(rawUrl: string): Promise<Response> { return this.display?.serve(rawUrl) ?? Promise.resolve(new Response('工程不存在。', { status: 404 })); }
  private assertContent(toolId: string, contextId?: string): void {
    this.assertAvailable();
    if (toolId !== this.tools()[0].id || (this.workspace || contextId !== undefined) && contextId !== this.contextId) {
      throw new Error('内容调用已过期或不属于当前工程。');
    }
  }
  private async withData<T>(task: (root: string, namespace: string, appId: string, projectData: boolean) => Promise<T>): Promise<T> {
    if (!this.workspace) return task(this.options.profile, this.options.manifest.id, this.options.manifest.appId, false);
    return this.workspace.withCurrent(async project => project
      ? task(project.dataDirectory, project.definition.id, project.definition.appId, true)
      : task(join(this.options.profile, 'window-data', this.options.id), this.options.manifest.id, this.options.manifest.appId, false));
  }
  async storage(toolId: string, request: StorageRequest, contextId?: string) {
    this.assertContent(toolId, contextId);
    if (!this.options.manifest.capabilities.includes('storage')) throw new Error('应用没有存储权限。');
    return this.withData(async (root, namespace, _appId, projectData) => {
      this.assertContent(toolId, contextId);
      let database = this.databases.get(root);
      if (!database) { database = new ToolStorage(projectData ? join(root, 'records.sqlite') : join(root, 'data', 'records.sqlite')); this.databases.set(root, database); }
      return database.execute(namespace, request);
    });
  }
  async service(toolId: string, service: string, method: string, input: Json, contextId?: string): Promise<Json> {
    this.assertContent(toolId, contextId);
    return this.withData(async (root, _namespace, appId) => {
      this.assertContent(toolId, contextId);
      let invoke = this.services.get(root);
      if (!invoke) { invoke = createServices({ ...this.options.manifest, appId }, this.options.root, root); this.services.set(root, invoke); }
      return invoke(service, method, input);
    });
  }
  private async stopTasks(): Promise<void> { await Promise.all([this.development?.dispose(), this.builds?.dispose(), this.versions?.dispose()]); }
  async dispose(): Promise<void> {
    this.disposed = true;
    await this.transition?.catch(() => {});
    await this.stopTasks(); await this.display?.dispose(); this.options.closePreviews();
    for (const database of this.databases.values()) database.close();
    this.databases.clear(); this.services.clear();
  }
}
