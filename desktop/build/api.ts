import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { CandidateBuild, CandidateBuildRequest, CandidateBuildResult, ProjectDefinition, WorkspaceProject } from '../../shared/contracts';
import { WorkspaceApi } from '../workspace/api';
import { directory, ensureDirectory, hash, writeText } from '../workspace/paths';
import { treeHashes } from '../workspace/source-tree';
import { applyCandidate, assertSnapshot, assertSource, saveSnapshot, sourceSnapshot } from './snapshot';
import { buildRoot, BuildStore, previewUrl } from './store';
import { BuildFailure, type BuildEngine, type BuildInput } from './types';
import { Capacity } from '../windows/capacity';
import { dependencies } from '../dependencies/policy';
import { dependencyPreparer, type DependencyPreparer } from '../dependencies/prepare';

type BuildObserver = (record: CandidateBuild) => Promise<void>;
interface Job { controller: AbortController; done: Promise<void>; release: () => void; progress?: BuildObserver }
export type PreviewOpener = (project: WorkspaceProject, record: CandidateBuild) => Promise<void>;
export class CandidateBuildApi {
  private readonly store = new BuildStore();
  private readonly jobs = new Map<string, Job>();
  private closed = false;
  constructor(private readonly workspace: WorkspaceApi, private readonly engine: BuildEngine,
    private readonly openPreview: PreviewOpener, private readonly timeoutMs = 300000,
    private readonly capacity = new Capacity(2, '当前最多同时运行两个候选构建。'),
    private readonly prepareDependencies: DependencyPreparer = dependencyPreparer()) {}
  async execute(input: unknown): Promise<CandidateBuildResult> {
    if (this.closed) throw new Error('候选构建服务已关闭。');
    const request = structuredClone(input) as CandidateBuildRequest;
    if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('无效的构建请求。');
    switch (request.operation) {
      case 'start': return this.start(request);
      case 'clearDependencyCache': return this.workspace.withProject(request.projectId, async project => {
        if (this.jobs.size) throw new Error('构建期间不能清理依赖缓存。');
        const cache = join(project.buildDirectory, '.dependency-cache');
        try { await directory(cache); await rm(cache, { recursive: true }); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        return { cleared: true };
      });
      case 'get': return this.workspace.withProject(request.projectId, async project => structuredClone(await this.load(project, request.buildId)));
      case 'cancel': return this.cancel(request.projectId, request.buildId);
      case 'openPreview': {
        const captured = await this.workspace.withProject(request.projectId, async project => {
          const record = await this.load(project, request.buildId);
          if (record.status !== 'succeeded' || !record.previewUrl) throw new Error('只能预览成功的构建。');
          await assertSource(project, record.sourceHashes, record.definitionHash);
          await this.store.verify(project, record);
          return { project, record };
        });
        await this.openPreview(captured.project, captured.record);
        return { buildId: captured.record.id, url: captured.record.previewUrl! };
      }
      default: throw new Error('不支持的构建操作。');
    }
  }
  async build(request: Extract<CandidateBuildRequest, { operation: 'start' }>, signal: AbortSignal, progress?: BuildObserver): Promise<CandidateBuild> {
    signal.throwIfAborted(); const record = await this.start(request, progress); const job = this.jobs.get(record.id);
    const cancel = () => job?.controller.abort('cancelled'); signal.addEventListener('abort', cancel, { once: true });
    try { if (signal.aborted) cancel(); await job?.done; return await this.workspace.withProject(request.projectId, project => this.load(project, record.id)); }
    finally { signal.removeEventListener('abort', cancel); }
  }
  private async load(project: WorkspaceProject, id: string): Promise<CandidateBuild> {
    const record = await this.store.load(project, id);
    if (record.status === 'running' && !this.jobs.has(id)) {
      record.status = 'interrupted'; record.finishedAt = new Date().toISOString(); record.previewUrl = null;
      record.logs = record.logs.slice(0, 63);
      record.logs.push({ level: 'error', message: '上次构建已中断，请重新构建；源工程未被修改。' });
      await this.store.save(project, record);
    }
    return record;
  }
  private async start(request: Extract<CandidateBuildRequest, { operation: 'start' }>, progress?: BuildObserver): Promise<CandidateBuild> {
    const started = await this.workspace.withProject(request.projectId, async project => {
      if (this.closed) throw new Error('候选构建服务已关闭。');
      if ([...this.jobs.values()].length >= 2) throw new Error('当前最多同时运行两个候选构建。');
      const snapshot = await sourceSnapshot(project);
      const input = { files: structuredClone(snapshot.files) };
      const candidateDependencies = await applyCandidate(project, input.files, request.candidate);
      if (candidateDependencies !== undefined && request.dependencies !== undefined) throw new Error('模型候选的依赖由候选记录确定，不能覆盖。');
      const declared = dependencies(candidateDependencies ?? request.dependencies ?? project.definition.dependencies);
      assertSnapshot(input);
      const record: CandidateBuild = { schemaVersion: 3, id: randomUUID(), projectId: project.definition.id,
        candidate: request.candidate ?? null, status: 'running', startedAt: new Date().toISOString(), finishedAt: null,
        definitionHash: snapshot.definitionHash, dependencies: declared, phase: 'resolving',
        candidateDefinitionHash: hash(JSON.stringify(project.definition)), sourceHashes: snapshot.hashes, candidateHashes: treeHashes(input.files), outputHashes: {}, previewUrl: null,
        logs: [{ level: 'info', message: '正在构建独立候选源码副本；源工程保持不变。' }] };
      const release = this.capacity.acquire();
      try {
        const root = await this.store.create(project, record);
        await saveSnapshot(await ensureDirectory(root, 'source'), input);
        await writeText(root, 'candidate-definition.json', JSON.stringify(project.definition));
      } catch (error) { release(); throw error; }
      const job: Job = { controller: new AbortController(), done: Promise.resolve(), release, progress };
      this.jobs.set(record.id, job);
      return { project, record, input, job };
    });
    started.job.done = this.run(started.project, started.record, started.input, started.job);
    return structuredClone(started.record);
  }
  private async run(project: WorkspaceProject, record: CandidateBuild, input: BuildInput, job: Job): Promise<void> {
    const { signal } = job.controller;
    const timer = setTimeout(() => job.controller.abort('timeout'), this.timeoutMs);
    let aborted: (() => void) | undefined;
    try {
      const output = await Promise.race([this.compile(project, record, input, signal, job.progress), new Promise<never>((_, reject) => {
        aborted = () => reject(signal.reason); signal.addEventListener('abort', aborted, { once: true }); if (signal.aborted) aborted();
      })]);
      await this.workspace.withProject(project.definition.id, async current => {
        signal.throwIfAborted();
        await assertSource(current, record.sourceHashes, record.definitionHash);
        record.outputHashes = await this.store.publish(current, record.id, output);
        signal.throwIfAborted();
        record.logs = [...record.logs, ...output.logs.slice(0, 40)].slice(-64); record.status = 'succeeded'; record.phase = 'complete'; record.previewUrl = previewUrl(record.id);
        record.finishedAt = new Date().toISOString(); await this.store.save(current, record); this.jobs.delete(record.id);
      });
      await job.progress?.(structuredClone(record));
    } catch (error) {
      record.status = signal.reason === 'cancelled' ? 'cancelled' : 'failed'; record.previewUrl = null; record.outputHashes = {};
      const message = signal.reason === 'cancelled' ? '候选构建已取消；源工程未被修改。'
        : signal.reason === 'timeout' ? '候选构建超时；源工程未被修改。'
        : signal.reason === 'closed' ? '应用关闭，候选构建已停止。' : '候选构建失败或源工程已变化；请检查日志后重新构建。';
      record.phase = 'complete';
      const detail = error instanceof Error ? error.message.slice(0, 1800) : message;
      record.logs = [...record.logs, ...(error instanceof BuildFailure ? error.logs.slice(0, 40) : [{ level: 'error' as const, message: signal.aborted ? message : detail }])].slice(-64);
      record.finishedAt = new Date().toISOString();
      await this.workspace.exclusive(async () => { await this.store.save(project, record).catch(() => {}); this.jobs.delete(record.id); });
    } finally {
      clearTimeout(timer); if (aborted) signal.removeEventListener('abort', aborted);
      if (this.jobs.get(record.id) === job) this.jobs.delete(record.id);
      job.release();
    }
  }
  private async compile(project: WorkspaceProject, record: CandidateBuild, input: BuildInput, signal: AbortSignal, progress?: BuildObserver) {
    const report = async (message: string) => {
      await this.workspace.exclusive(async () => {
        signal.throwIfAborted();
        record.phase = message.startsWith('安装') ? 'installing' : record.phase;
        record.logs = [...record.logs, { level: 'info' as const, message }].slice(-63);
        await this.store.save(project, record);
      });
      await progress?.(structuredClone(record));
    };
    const prepared = await this.prepareDependencies(project, buildRoot(project, record.id), record.dependencies, signal, report);
    signal.throwIfAborted();
    const definition: ProjectDefinition = { ...project.definition, dependencies: record.dependencies, dependencyLock: prepared.lock };
    const content = JSON.stringify(definition);
    await this.workspace.withProject(project.definition.id, async current => {
      signal.throwIfAborted(); await assertSource(current, record.sourceHashes, record.definitionHash);
      await writeText(buildRoot(project, record.id), 'candidate-definition.json', content);
      record.candidateDefinitionHash = hash(content); record.phase = 'compiling';
      await this.store.save(project, record);
    });
    await report('正在使用独立源码与锁定依赖构建候选。');
    return this.engine({ ...input, dependencyLock: prepared.lock, dependencyFiles: prepared.files }, signal);
  }
  private async cancel(projectId: string, id: string): Promise<CandidateBuild> {
    const job = await this.workspace.withProject(projectId, async project => {
      await this.store.load(project, id); const job = this.jobs.get(id); job?.controller.abort('cancelled'); return job;
    });
    if (job) await job.done;
    return this.workspace.withProject(projectId, async project => structuredClone(await this.load(project, id)));
  }
  async dispose(): Promise<void> {
    this.closed = true;
    const jobs = await this.workspace.exclusive(async () => [...this.jobs.values()]);
    for (const job of jobs) job.controller.abort('closed');
    await Promise.all(jobs.map(job => job.done));
  }
}
