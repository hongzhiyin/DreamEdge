import type { ProjectContext, WorkspaceProject } from '../../shared/contracts';
import { dependencyList, resolveDependency } from './dependency-tools';
import { WorkspaceApi } from '../workspace/api';
import { hash, relativeParts } from '../workspace/paths';
import { listProjectFiles, readProjectFile } from '../workspace/project-files';
import { CONTEXT_FILES, CONTEXT_LIMIT, modelDefinition, shortText, validateProposal } from './context';
import { AgentGitAccess } from './git-access';

/** Paths are relative to the business project; host paths and private files stay hidden. */
export class ProjectAccess {
  readonly git: AgentGitAccess;
  get commitMessage() { return this.git.message; }
  dependencies?: Record<string, string>;
  constructor(private readonly workspace: WorkspaceApi, private readonly projectId: string, private readonly context: ProjectContext, commitAllowed = false, restoreAllowed = false) {
    this.git = new AgentGitAccess(workspace, projectId, context, { commit: commitAllowed, restore: restoreAllowed });
  }
  async execute(name: string, args: Record<string, unknown>, signal: AbortSignal, beforeExpose: (value: unknown) => void = () => {}): Promise<unknown> {
    if (name.startsWith('git_')) return this.git.execute(name, args, signal, beforeExpose);
    if (name === 'resolve_dependency') {
      await this.workspace.withProject(this.projectId, async project => this.assertDefinition(project));
      beforeExpose(args); const result = await resolveDependency(args, signal); signal.throwIfAborted();
      return this.workspace.withProject(this.projectId, async project => { this.assertDefinition(project); beforeExpose(result); return result; });
    }
    return this.workspace.withProject(this.projectId, async project => {
      signal.throwIfAborted();
      this.assertDefinition(project);
      if (name === 'set_dependencies') {
        beforeExpose(args); this.dependencies = dependencyList(args.packages);
        return { queued: true, dependencies: this.dependencies, detail: '完整依赖声明已暂存，propose_changes 后自动构建并应用。' };
      }
      if (name === 'propose_changes') {
        if (this.git.restore && ((args.files as unknown[])?.length || this.dependencies !== undefined)) throw new Error('Git 恢复必须单独一轮，结束时请提交 files: []，不混入新修改或依赖声明。');
        const restore = this.git.restore;
        beforeExpose(args); await validateProposal(project, this.context, { ...args, files: restore?.files ?? args.files, dependencies: restore?.dependencies ?? this.dependencies });
        signal.throwIfAborted(); return { accepted: true };
      }
      if (name === 'read_file') {
        relativeParts(args.path);
        return this.capture(project, args.path as string, signal, beforeExpose);
      }
      const prefix = this.prefix(args.directory);
      if (name === 'list_files') {
        if (!Number.isSafeInteger(args.offset) || (args.offset as number) < 0) throw new Error('文件列表起点无效。');
        const files = (await listProjectFiles(project)).filter(path => path.startsWith(prefix));
        const offset = args.offset as number; signal.throwIfAborted();
        const result = { files: files.slice(offset, offset + 100), total: files.length, nextOffset: offset + 100 < files.length ? offset + 100 : null };
        beforeExpose(result); return result;
      }
      if (name === 'search_files') return this.search(project, prefix, shortText(args.query, '搜索文本', 160), signal, beforeExpose);
      throw new Error('工具未开放。');
    });
  }
  private assertDefinition(project: WorkspaceProject) {
    if (JSON.stringify(modelDefinition(project.definition)) !== JSON.stringify(this.context.definition)) throw new Error('工程描述已变化，请重新发送请求。');
  }
  private prefix(value: unknown): string {
    if (value === '') return '';
    relativeParts(value); return (value as string) + '/';
  }
  private async capture(project: WorkspaceProject, path: string, signal: AbortSignal, beforeExpose: (value: unknown) => void) {
    const content = await readProjectFile(project, path); signal.throwIfAborted();
    const previous = this.context.files.find(file => file.path === path); const checksum = hash(content);
    beforeExpose({ path, content, hash: checksum });
    if (previous && previous.hash !== checksum) throw new Error('已读取的源码发生变化，请重新发送请求。');
    if (!previous) {
      if (this.context.files.length >= CONTEXT_FILES || this.context.files.reduce((sum, file) => sum + Buffer.byteLength(file.content), 0)
        + Buffer.byteLength(content) > CONTEXT_LIMIT) throw new Error('本轮读取超过 64 个文件或 128 KB，请缩小修改范围。');
      this.context.files.push({ path, content, hash: checksum });
    }
    return { path, content, hash: checksum };
  }
  private async search(project: WorkspaceProject, prefix: string, query: string, signal: AbortSignal, beforeExpose: (value: unknown) => void) {
    const matches: { path: string; line: number; text: string }[] = []; let bytes = 0;
    for (const path of (await listProjectFiles(project)).filter(path => path.startsWith(prefix))) {
      signal.throwIfAborted(); let content: string;
      try { content = await readProjectFile(project, path); } catch { continue; }
      bytes += Buffer.byteLength(content);
      if (bytes > 8 * 1024 * 1024) return { matches, truncated: true };
      if (!content.includes(query)) continue;
      const file = await this.capture(project, path, signal, beforeExpose);
      const lines = file.content.split('\n');
      for (let index = 0; index < lines.length; index++) if (lines[index].includes(query)) {
        matches.push({ path, line: index + 1, text: lines[index].slice(0, 240) });
        if (matches.length >= 50) return { matches, truncated: true };
      }
    }
    signal.throwIfAborted(); return { matches, truncated: false };
  }
}
