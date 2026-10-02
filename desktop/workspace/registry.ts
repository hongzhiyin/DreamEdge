import { mkdir } from 'node:fs/promises';
import type { WorkspaceProject } from '../../shared/contracts';
import { directory, readText, writeText } from './paths';

export interface Entry { id: string; root: string }
export interface WorkspaceSelection {
  load(): Promise<Entry | null>;
  assertIdentity(project: WorkspaceProject): void;
  select(project: WorkspaceProject | null): Promise<void>;
}
interface State { schemaVersion: 1; active: Entry | null; projects: Entry[] }
export class WorkspaceRegistry implements WorkspaceSelection {
  private state: State = { schemaVersion: 1, active: null, projects: [] };
  private queue: Promise<unknown> = Promise.resolve();
  readonly ready: Promise<void>;
  constructor(private readonly dataDirectory: string) { this.ready = this.read(); }
  private async read(): Promise<void> {
    await mkdir(this.dataDirectory, { recursive: true });
    await directory(this.dataDirectory);
    let content: string;
    try { content = await readText(this.dataDirectory, 'workspace-state.json'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    const value = JSON.parse(content) as State;
    const valid = (entry: Entry) => entry && typeof entry.id === 'string' && typeof entry.root === 'string';
    if (!value || value.schemaVersion !== 1 || !Array.isArray(value.projects) || value.projects.some(entry => !valid(entry))
        || (value.active !== null && !valid(value.active))) throw new Error('工作区恢复记录格式无效。');
    this.state = value;
  }
  async load(): Promise<Entry | null> { await this.ready; return structuredClone(this.state.active); }
  assertIdentity(project: WorkspaceProject): void {
    const found = this.state.projects.find(entry => entry.id === project.definition.id);
    if (found && found.root !== project.rootDirectory) throw new Error('工程身份已绑定其他目录，请使用独立的工程身份。');
  }
  private update(project: WorkspaceProject | null, select: boolean): Promise<void> {
    const result = this.queue.then(async () => {
      await this.ready;
      if (project) this.assertIdentity(project);
      const entry = project ? { id: project.definition.id, root: project.rootDirectory } : null;
      const projects = entry ? [...this.state.projects.filter(value => value.id !== entry.id), entry] : this.state.projects;
      const next: State = { schemaVersion: 1, active: select ? entry : this.state.active, projects };
      await writeText(this.dataDirectory, 'workspace-state.json', JSON.stringify(next, null, 2)); this.state = next;
    });
    this.queue = result.catch(() => {}); return result;
  }
  select(project: WorkspaceProject | null): Promise<void> { return this.update(project, true); }
  register(project: WorkspaceProject): Promise<void> { return this.update(project, false); }
}
