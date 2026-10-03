import { mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import type { ProjectDefinition, WorkspaceProject, WorkspaceStatus } from '../../shared/contracts';
import { createDefinition, DEFINITION_FILE, projectName, projectVersion, validateDefinition } from './definition';
import { canonicalTarget, directory, ensureDirectory, hash, inside, readText, writeText } from './paths';
import { WorkspaceRegistry, type WorkspaceSelection } from './registry';
import { recoverTransaction } from '../changes/recovery';
import { initializeGit } from '../git/repository';

export class WorkspaceManager {
  private readonly registry: WorkspaceSelection;
  private selected: WorkspaceProject | null = null;
  private definitionHash = '';
  private recoveryError: string | null = null;
  readonly ready: Promise<void>;
  constructor(private readonly dataDirectory: string, private readonly frameworkRoot: string, selection?: WorkspaceSelection) {
    this.registry = selection ?? new WorkspaceRegistry(dataDirectory);
    this.ready = this.restore();
  }
  private async restore(): Promise<void> {
    try {
      const active = await this.registry.load();
      if (active) {
        const { project, definitionHash } = await this.inspect(active.root);
        if (project.definition.id !== active.id) throw new Error('工程身份发生变化。');
        this.registry.assertIdentity(project);
        this.selected = project;
        this.definitionHash = definitionHash;
      }
    } catch { this.recoveryError = '上次工程无法恢复，请重新打开有效工程；现有源码未被修改。'; }
  }
  private async assertAllowed(root: string): Promise<void> {
    const framework = await realpath(this.frameworkRoot);
    const profile = await directory(this.dataDirectory);
    if ([framework, profile].some(protectedRoot => inside(protectedRoot, root) || inside(root, protectedRoot))) {
      throw new Error('工程目录不能包含或位于框架安装目录、源码目录或用户数据区。');
    }
  }
  private async layout(root: string, definition: ProjectDefinition): Promise<WorkspaceProject> {
    const sourceDirectory = await directory(join(root, definition.source));
    const base = await ensureDirectory(this.dataDirectory, `workspaces/${definition.id}`);
    return { definition, rootDirectory: root, sourceDirectory,
      dataDirectory: await ensureDirectory(base, 'data'), buildDirectory: await ensureDirectory(base, 'build'),
      sessionsDirectory: await ensureDirectory(base, 'sessions') };
  }
  private async inspect(path: unknown): Promise<{ project: WorkspaceProject; definitionHash: string }> {
    const root = await canonicalTarget(path, true);
    await this.assertAllowed(root);
    await recoverTransaction(root, this.dataDirectory);
    const content = await readText(root, DEFINITION_FILE);
    const definition = validateDefinition(JSON.parse(content));
    // Reject identity reuse before creating or accessing another project's managed directories.
    this.registry.assertIdentity({ definition, rootDirectory: root } as WorkspaceProject);
    await initializeGit(root);
    return { project: await this.layout(root, definition), definitionHash: hash(content) };
  }
  private async select(project: WorkspaceProject, definitionHash: string): Promise<WorkspaceProject> {
    if (hash(await readText(project.rootDirectory, DEFINITION_FILE)) !== definitionHash) throw new Error('工程描述已发生变化，请重新打开工程。');
    await this.registry.select(project);
    this.selected = project; this.definitionHash = definitionHash; this.recoveryError = null;
    return project;
  }
  async current(): Promise<WorkspaceStatus> {
    await this.ready;
    return { project: this.selected, recoveryError: this.recoveryError };
  }
  async create(path: unknown, name: unknown): Promise<WorkspaceProject> {
    await this.ready;
    const definition = createDefinition(name);
    const root = await canonicalTarget(path, false);
    await this.assertAllowed(root);
    await mkdir(root); // Exclusive creation: an existing directory is never overwritten.
    await ensureDirectory(root, 'src');
    await ensureDirectory(root, '.dreamedge');
    await writeText(root, 'src/index.html', '<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><div id="root"></div><script type="module" src="./main.ts"></script></html>\n');
    await writeText(root, 'src/main.ts', "document.getElementById('root')!.textContent = 'HelloWorld';\n");
    const content = JSON.stringify(definition, null, 2);
    await writeText(root, DEFINITION_FILE, content);
    await initializeGit(root);
    return this.select(await this.layout(root, definition), hash(content));
  }
  async open(path: unknown): Promise<WorkspaceProject> {
    await this.ready;
    const { project, definitionHash } = await this.inspect(path);
    return this.select(project, definitionHash);
  }
  async close(): Promise<WorkspaceStatus> {
    await this.ready;
    await this.registry.select(null); this.selected = null; this.recoveryError = null;
    return this.current();
  }
  async project(id: unknown): Promise<WorkspaceProject> {
    await this.ready;
    if (!this.selected || id !== this.selected.definition.id) throw new Error('请求不属于当前工程，请重新读取当前工作区。');
    const content = await readText(this.selected.rootDirectory, DEFINITION_FILE);
    if (hash(content) !== this.definitionHash) throw new Error('工程描述已被外部修改，请重新打开工程。');
    await directory(this.selected.sourceDirectory);
    return this.selected;
  }
  async refresh(id: unknown): Promise<void> {
    if (!this.selected || id !== this.selected.definition.id) throw new Error('当前工程已变化。');
    const { project, definitionHash } = await this.inspect(this.selected.rootDirectory);
    if (project.definition.id !== id) throw new Error('工程身份发生变化。');
    this.selected = project; this.definitionHash = definitionHash;
  }
  async save(id: unknown, changes: { name?: unknown; version?: unknown }): Promise<WorkspaceProject> {
    const project = await this.project(id);
    const definition = { ...project.definition, name: changes.name === undefined ? project.definition.name : projectName(changes.name),
      version: changes.version === undefined ? project.definition.version : projectVersion(changes.version), savedAt: new Date().toISOString() };
    const content = JSON.stringify(definition, null, 2);
    await writeText(project.rootDirectory, DEFINITION_FILE, content);
    this.selected = { ...project, definition }; this.definitionHash = hash(content);
    return this.selected;
  }
}
