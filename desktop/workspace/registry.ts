import { mkdir } from 'node:fs/promises';
import type { WorkspaceProject } from '../../shared/contracts';
import { directory, readText, writeText } from './paths';

interface Entry { id: string; root: string }
interface State { schemaVersion: 1; active: Entry | null; projects: Entry[] }
export class WorkspaceRegistry {
  private state: State = { schemaVersion: 1, active: null, projects: [] };
  constructor(private readonly dataDirectory: string) {}
  async load(): Promise<Entry | null> {
    await mkdir(this.dataDirectory, { recursive: true });
    await directory(this.dataDirectory);
    let content: string;
    try { content = await readText(this.dataDirectory, 'workspace-state.json'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    const value = JSON.parse(content) as State;
    const valid = (entry: Entry) => entry && typeof entry.id === 'string' && typeof entry.root === 'string';
    if (!value || value.schemaVersion !== 1 || !Array.isArray(value.projects) || value.projects.some(entry => !valid(entry))
        || (value.active !== null && !valid(value.active))) throw new Error('工作区恢复记录格式无效。');
    this.state = value;
    return value.active;
  }
  assertIdentity(project: WorkspaceProject): void {
    const found = this.state.projects.find(entry => entry.id === project.definition.id);
    if (found && found.root !== project.rootDirectory) throw new Error('工程身份已绑定其他目录，请使用独立的工程身份。');
  }
  async select(project: WorkspaceProject | null): Promise<void> {
    if (project) this.assertIdentity(project);
    const active = project ? { id: project.definition.id, root: project.rootDirectory } : null;
    const projects = active ? [...this.state.projects.filter(entry => entry.id !== active.id), active] : this.state.projects;
    const next: State = { schemaVersion: 1, active, projects };
    await writeText(this.dataDirectory, 'workspace-state.json', JSON.stringify(next, null, 2));
    this.state = next;
  }
}
