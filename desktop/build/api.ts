import { randomUUID } from 'node:crypto';
import type { CandidateBuild, CandidateBuildRequest, CandidateBuildResult, WorkspaceProject } from '../../shared/contracts';
import { WorkspaceApi } from '../workspace/api';
import { ensureDirectory } from '../workspace/paths';
import { treeHashes } from '../workspace/source-tree';
import { applyCandidate, assertSnapshot, assertSource, saveSnapshot, sourceSnapshot } from './snapshot';
import { BuildStore, previewUrl } from './store';
import { BuildFailure, type BuildEngine, type BuildInput } from './types';

interface Job { controller: AbortController; done: Promise<void> }
export type PreviewOpener = (project: WorkspaceProject, record: CandidateBuild) => Promise<void>;
export class CandidateBuildApi {
  private readonly store = new BuildStore();
  private readonly jobs = new Map<string, Job>();
  private closed = false;
  constructor(private readonly workspace: WorkspaceApi, private readonly engine: BuildEngine,
    private readonly openPreview: PreviewOpener, private readonly timeoutMs = 30000) {}
  async execute(input: unknown): Promise<CandidateBuildResult> {
    if (this.closed) throw new Error('候选构建服务已关闭。');
    const request = structuredClone(input) as CandidateBuildRequest;
    if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('无效的构建请求。');
    switch (request.operation) {
      case 'start': return this.start(request);
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
  private async start(request: Extract<CandidateBuildRequest, { operation: 'start' }>): Promise<CandidateBuild> {
    const started = await this.workspace.withProject(request.projectId, async project => {
      if (this.closed) throw new Error('候选构建服务已关闭。');
      if ([...this.jobs.values()].length >= 2) throw new Error('当前最多同时运行两个候选构建。');
      if (Object.keys(project.definition.dependencies).length) throw new Error('当前候选构建不支持 npm 依赖安装，请使用无外部依赖的工程。');
      const snapshot = await sourceSnapshot(project);
      const input = { files: structuredClone(snapshot.files) };
      await applyCandidate(project, input.files, request.candidate);
      assertSnapshot(input);
      const record: CandidateBuild = { schemaVersion: 2, id: randomUUID(), projectId: project.definition.id,
        candidate: request.candidate ?? null, status: 'running', startedAt: new Date().toISOString(), finishedAt: null,
        definitionHash: snapshot.definitionHash, sourceHashes: snapshot.hashes, candidateHashes: treeHashes(input.files), outputHashes: {}, previewUrl: null,
        logs: [{ level: 'info', message: '正在构建独立候选源码副本；源工程保持不变。' }] };
      const root = await this.store.create(project, record);
      await saveSnapshot(await ensureDirectory(root, 'source'), input);
      const job: Job = { controller: new AbortController(), done: Promise.resolve() };
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
      const output = await Promise.race([this.engine(input, signal), new Promise<never>((_, reject) => {
        aborted = () => reject(signal.reason); signal.addEventListener('abort', aborted, { once: true }); if (signal.aborted) aborted();
      })]);
      await this.workspace.withProject(project.definition.id, async current => {
        signal.throwIfAborted();
        await assertSource(current, record.sourceHashes, record.definitionHash);
        record.outputHashes = await this.store.publish(current, record.id, output);
        signal.throwIfAborted();
        record.logs.push(...output.logs.slice(0, 40)); record.status = 'succeeded'; record.previewUrl = previewUrl(record.id);
        record.finishedAt = new Date().toISOString(); await this.store.save(current, record); this.jobs.delete(record.id);
      });
    } catch (error) {
      record.status = signal.reason === 'cancelled' ? 'cancelled' : 'failed'; record.previewUrl = null; record.outputHashes = {};
      const message = signal.reason === 'cancelled' ? '候选构建已取消；源工程未被修改。'
        : signal.reason === 'timeout' ? '候选构建超时；源工程未被修改。'
        : signal.reason === 'closed' ? '应用关闭，候选构建已停止。' : '候选构建失败或源工程已变化；请检查日志后重新构建。';
      record.logs.push(...(error instanceof BuildFailure ? error.logs.slice(0, 40) : [{ level: 'error' as const, message }]));
      record.finishedAt = new Date().toISOString();
      await this.workspace.exclusive(async () => { await this.store.save(project, record).catch(() => {}); this.jobs.delete(record.id); });
    } finally {
      clearTimeout(timer); if (aborted) signal.removeEventListener('abort', aborted);
      if (this.jobs.get(record.id) === job) this.jobs.delete(record.id);
    }
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
