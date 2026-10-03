import type { ProjectContext, WorkspaceProject } from '../../shared/contracts';
import { dependencyList, resolveDependency } from './dependency-tools';
import { WorkspaceApi } from '../workspace/api';
import { hash, listSource, readText, relativeParts } from '../workspace/paths';
import { CONTEXT_FILES, CONTEXT_LIMIT, modelDefinition, shortText, validateProposal } from './context';

/** All paths are relative to src; the model never receives a host filesystem path. */
export class ProjectAccess {
  commitMessage?: string;
  dependencies?: Record<string, string>;
  constructor(private readonly workspace: WorkspaceApi, private readonly projectId: string, private readonly context: ProjectContext, private readonly commitAllowed = false) {}
  async execute(name: string, args: Record<string, unknown>, signal: AbortSignal, beforeExpose: (value: unknown) => void = () => {}): Promise<unknown> {
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
      if (name === 'git_commit') {
        if (!this.commitAllowed) throw new Error('本轮没有授权 Git 提交。');
        beforeExpose(args); this.commitMessage = shortText(args.message, 'Git 提交说明', 500);
        return { queued: true, detail: '本轮修改构建并应用成功后，由框架提交 Git。' };
      }
      if (name === 'propose_changes') {
        beforeExpose(args); await validateProposal(project, this.context, { ...args, dependencies: this.dependencies });
        signal.throwIfAborted(); return { accepted: true };
      }
      if (name === 'read_file') {
        relativeParts(args.path);
        return this.capture(project, args.path as string, signal, beforeExpose);
      }
      const prefix = this.prefix(args.directory);
      if (name === 'list_files') {
        if (!Number.isSafeInteger(args.offset) || (args.offset as number) < 0) throw new Error('文件列表起点无效。');
        const files = (await listSource(project.sourceDirectory)).filter(path => path.startsWith(prefix));
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
    const content = await readText(project.sourceDirectory, path); signal.throwIfAborted();
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
    for (const path of (await listSource(project.sourceDirectory)).filter(path => path.startsWith(prefix))) {
      signal.throwIfAborted(); const content = await readText(project.sourceDirectory, path);
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
