import type { ModelSettingsRequest, WorkspaceProject } from '../../shared/contracts';
import type { ModelAccess, ModelInput, ModelProvider } from '../development/model';
import { ModelSettings } from './settings';
import { ProjectConnectionFile } from './file';

/** Selection is supplied by the window, avoiding re-entry into the workspace queue. */
export class ProjectModels implements ModelProvider {
  private current?: { id: string; settings: ModelSettings };
  constructor(private readonly selected: () => WorkspaceProject | null, private readonly changed: () => void) {}
  private service(): ModelSettings {
    const project = this.selected();
    if (!project) throw new Error('请先新建或打开工程，再配置模型连接。');
    if (!this.current) this.current = { id: project.definition.id, settings: new ModelSettings(new ProjectConnectionFile(project.rootDirectory), project.definition.id, this.changed) };
    if (this.current.id !== project.definition.id) throw new Error('模型连接正在切换工程，请稍后重试。');
    return this.current.settings;
  }
  execute(input: unknown) {
    const request = input as ModelSettingsRequest;
    if (!request || request.projectId !== this.selected()?.definition.id) throw new Error('模型配置请求不属于当前工程。');
    return this.service().execute(request);
  }
  connection() { return this.service().connection(); }
  assertSafeInput(input: ModelInput) { return this.service().assertSafeInput(input); }
  generate(input: ModelInput, signal: AbortSignal, access?: ModelAccess) { return this.service().generate(input, signal, access); }
  async reset(): Promise<void> { const current = this.current; this.current = undefined; await current?.settings.dispose(); }
}
