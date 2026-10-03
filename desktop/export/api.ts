import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, lstat, readdir } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import type { ExportRequest, ExportResult, ProjectExport, WorkspaceProject } from '../../shared/contracts';
import { WorkspaceApi } from '../workspace/api';
import { CandidateBuildApi } from '../build/api';
import { BuildStore, buildRoot } from '../build/store';
import { assertSource } from '../build/snapshot';
import { canonicalTarget, inside, writeText, readText, directory } from '../workspace/paths';
import { readSourceTree } from '../workspace/source-tree';
import { identifier } from '../development/sessions';
import { prepareTooling } from './tooling';
import { publishExport } from './publish';
import { stageExport } from './stage';
import type { ExportEngine, ExportResources } from './types';

interface Job { record: ProjectExport; controller: AbortController; done: Promise<void> }
export class ProjectExports {
  private readonly jobs = new Map<string, Job>(); private readonly latest = new Map<string, string>(); private closed = false; private preparing = false;
  constructor(private readonly workspace: WorkspaceApi, private readonly profile: string, private readonly frameworkRoot: string,
    private readonly resources: ExportResources, private readonly builds: CandidateBuildApi, private readonly engine: ExportEngine,
    private readonly supported = process.platform === 'darwin', private readonly prepare = prepareTooling,
    private readonly safeSource?: (snapshot: import('./types').ExportSnapshot) => Promise<void>) {}
  async execute(input: unknown): Promise<ExportResult> {
    if (this.closed) throw new Error('导出服务已关闭。');
    const request = structuredClone(input) as ExportRequest;
    if (request?.operation === 'start') return this.start(request);
    const project = await this.workspace.withProject(request?.projectId, async value => value);
    if (request.operation === 'current') {
      let record: ProjectExport | null = null; const id = this.latest.get(project.definition.id);
      if (id) record = await this.load(project, id);
      else {
        const folder = join(this.profile, 'exports'); const names = await readdir(folder).catch(() => []);
        for (const name of names) { try { const value = await this.load(project, name); if (!record || value.startedAt > record.startedAt) record = value; } catch {} }
        if (record) this.latest.set(project.definition.id, record.id);
      }
      return { supported: this.supported, platform: process.platform, arch: process.arch, record };
    }
    if (!['get', 'cancel'].includes(request.operation)) throw new Error('不支持的导出操作。');
    if (request.operation === 'cancel') {
      const job = this.jobs.get(request.exportId); if (job && job.record.projectId !== project.definition.id) throw new Error('导出不属于当前工程。');
      if (job?.record.phase === 'publishing') throw new Error('导出正在完成写入，请等待结果。');
      job?.controller.abort('cancelled'); await job?.done;
    }
    return this.load(project, request.exportId);
  }
  private root(id: string) { return join(this.profile, 'exports', identifier(id)); }
  private save(record: ProjectExport) { return writeText(this.root(record.id), 'record.json', JSON.stringify(record)); }
  private async load(project: WorkspaceProject, id: string): Promise<ProjectExport> {
    const record = JSON.parse(await readText(this.root(id), 'record.json')) as ProjectExport;
    if (record.id !== id || record.schemaVersion !== 1 || record.projectId !== project.definition.id
      || !['running', 'succeeded', 'failed', 'cancelled', 'interrupted'].includes(record.status) || !['building', 'packaging', 'publishing', 'complete'].includes(record.phase)
      || typeof record.directory !== 'string' || !isAbsolute(record.directory) || record.directory.includes('\0')
      || !Array.isArray(record.logs) || record.logs.length > 81 || record.logs.some(log => typeof log !== 'string' || log.length > 1800)
      || !Number.isFinite(Date.parse(record.startedAt)) || record.finishedAt !== null && !Number.isFinite(Date.parse(record.finishedAt))) throw new Error('导出记录不属于当前工程。');
    if (record.status === 'running' && !this.jobs.has(id)) { record.status = 'interrupted'; record.phase = 'complete'; record.error = '上次导出已中断，请选择新目录重试。'; record.finishedAt = new Date().toISOString(); await this.save(record); }
    return structuredClone(record);
  }
  private async start(request: Extract<ExportRequest, { operation: 'start' }>) {
    if (!this.supported) throw new Error('当前仅支持在 macOS 上导出本机架构 App。');
    if (this.jobs.size || this.preparing) throw new Error('当前窗口已有导出任务，请等待或取消。');
    this.preparing = true;
    try {
    const project = await this.workspace.withProject(request.projectId, async value => value);
    const target = await canonicalTarget(request.directory, false);
    for (const protectedRoot of [project.rootDirectory, this.frameworkRoot, this.profile]) {
      const root = await directory(protectedRoot); if (inside(root, target) || inside(target, root)) throw new Error('导出目录必须与工程、框架和用户数据目录分开。');
    }
    try { await lstat(target); throw new Error('导出目录已存在，请选择新目录。'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (this.closed) throw new Error('导出窗口已关闭。');
    const record: ProjectExport = { schemaVersion: 1, id: randomUUID(), projectId: project.definition.id, status: 'running', phase: 'building',
      startedAt: new Date().toISOString(), finishedAt: null, logs: ['正在构建已保存的工程。'], directory: target, error: null };
    const saved = await readdir(join(this.profile, 'exports')).catch(() => []); if (saved.length >= 100) throw new Error('当前最多保留 100 次导出记录。');
    await mkdir(this.root(record.id), { recursive: true }); await this.save(record);
    const job = { record, controller: new AbortController(), done: Promise.resolve() }; this.jobs.set(record.id, job); this.latest.set(project.definition.id, record.id);
    job.done = this.run(project, job); return structuredClone(record);
    } finally { this.preparing = false; }
  }
  private async run(project: WorkspaceProject, job: Job) {
    const { record, controller } = job; const { signal } = controller; const timer = setTimeout(() => controller.abort('timeout'), 900000);
    const log = async (message: string) => { signal.throwIfAborted(); if (message) record.logs = [...record.logs, message.slice(0, 1800)].slice(-80); await this.save(record); };
    const work = join(this.root(record.id), 'work'); let ownedTarget = false;
    try {
      const built = await this.builds.build({ operation: 'start', projectId: project.definition.id }, signal, state => log(state.logs.at(-1)?.message ?? ''));
      if (built.status !== 'succeeded') throw new Error(built.logs.map(item => item.message).join('\n').slice(-1800));
      const store = new BuildStore(); const captured = await this.workspace.withProject(project.definition.id, async current => {
        await assertSource(current, built.sourceHashes, built.definitionHash); await store.verify(current, built);
        const source = await readSourceTree(join(buildRoot(current, built.id), 'source')); const outputs: Record<string, string> = {};
        for (const path of Object.keys(built.outputHashes)) outputs[path] = await readFile(join(buildRoot(current, built.id), 'output', path), 'utf8');
        return { files: source.files, outputs, definition: await store.candidateDefinition(current, built) };
      });
      await this.safeSource?.(captured);
      signal.throwIfAborted(); record.phase = 'packaging'; await log('正在准备独立源码工程与固定框架运行环境。');
      await mkdir(work); const manifest = await stageExport(work, captured, this.resources); signal.throwIfAborted();
      await log('正在准备本地打包工具。'); await this.prepare(work, signal);
      await this.engine({ root: work, manifest }, signal, log); signal.throwIfAborted();
      await this.workspace.withProject(project.definition.id, current => assertSource(current, built.sourceHashes, built.definitionHash));
      if (await canonicalTarget(record.directory, false) !== record.directory) throw new Error('导出目标父目录已变化。');
      record.phase = 'publishing'; await log('正在完成导出写入。');
      await mkdir(record.directory); ownedTarget = true;
      await publishExport(join(work, 'deliverable'), record.directory);
      record.status = 'succeeded'; record.phase = 'complete'; record.finishedAt = new Date().toISOString(); record.logs.push('导出完成：独立 App、ZIP 与可继续开发的源码工程。'); await this.save(record);
    } catch (error) {
      record.status = signal.reason === 'cancelled' || signal.reason === 'closed' ? 'cancelled' : 'failed'; record.phase = 'complete'; record.finishedAt = new Date().toISOString();
      record.error = signal.reason === 'timeout' ? '导出超时，请重试。' : error instanceof Error ? error.message.slice(-1800) : '导出失败。';
      if (ownedTarget) record.error += ` 未完成的导出保留在 ${record.directory}，请核对后选择新目录重试。`;
      await this.save(record).catch(() => {});
    } finally { clearTimeout(timer); this.jobs.delete(record.id); await rm(work, { recursive: true, force: true }).catch(() => {}); }
  }
  async dispose() { this.closed = true; for (const job of this.jobs.values()) if (job.record.phase !== 'publishing') job.controller.abort('closed'); await Promise.all([...this.jobs.values()].map(job => job.done)); }
}
