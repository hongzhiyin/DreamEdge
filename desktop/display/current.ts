import { randomUUID } from 'node:crypto';
import type { ToolManifest, WorkspaceProject } from '../../shared/contracts';
import { WorkspaceApi } from '../workspace/api';
import { ensureDirectory } from '../workspace/paths';
import { sourceSnapshot, assertSnapshot, assertSource } from '../build/snapshot';
import type { BuildEngine } from '../build/types';
import { BuildFailure } from '../build/types';
import { dependencyPreparer, type DependencyPreparer } from '../dependencies/prepare';
import { Capacity } from '../windows/capacity';
import { DisplayStore, displayEntry, type DisplayRecord } from './store';
import { reuseBuild } from './build';

export class SavedProjectDisplay {
  private readonly store = new DisplayStore();
  private active: { project: WorkspaceProject; record: DisplayRecord } | null = null;
  private job: { controller: AbortController; done: Promise<void> } | null = null;
  private generation = 0;
  private closed = false;
  status?: ToolManifest['projectView'];
  constructor(private readonly workspace: WorkspaceApi, private readonly engine: BuildEngine, private readonly capacity: Capacity,
    private readonly changed: () => void, private readonly prepare: DependencyPreparer = dependencyPreparer()) {}
  get entry(): string | undefined { return this.active ? displayEntry(this.active.record) : undefined; }
  refresh(buildId?: string): void {
    if (this.closed) return;
    this.job?.controller.abort(); const generation = ++this.generation;
    this.active = null; this.status = { status: 'loading', error: null }; this.changed();
    const job = { controller: new AbortController(), done: Promise.resolve() }; this.job = job;
    job.done = this.run(job.controller.signal, generation, buildId).finally(() => { if (this.job === job) this.job = null; });
  }
  private async run(signal: AbortSignal, generation: number, buildId?: string): Promise<void> {
    let release: (() => void) | undefined;
    let timedOut = false;
    const timer = setTimeout(() => {
      if (this.job?.controller.signal === signal) { timedOut = true; this.job.controller.abort(); }
    }, 300000);
    try {
      const captured = await this.workspace.withCurrent(async project => project ? { project, snapshot: await sourceSnapshot(project) } : null);
      signal.throwIfAborted();
      if (!captured) { this.status = undefined; this.changed(); return; }
      const { project, snapshot } = captured;
      let record = await this.store.cached(project, snapshot.definitionHash, snapshot.hashes);
      if (!record && buildId) record = await reuseBuild(this.store, project, snapshot, buildId).catch(() => null);
      if (!record) {
        while (!release) {
          signal.throwIfAborted();
          try { release = this.capacity.acquire(); }
          catch { await new Promise(resolve => setTimeout(resolve, 40)); }
        }
        const input = { files: snapshot.files }; assertSnapshot(input);
        const id = randomUUID(); const root = await ensureDirectory(await this.store.root(project), id);
        const dependencies = await this.prepare(project, root, project.definition.dependencies, signal, async () => { signal.throwIfAborted(); });
        signal.throwIfAborted();
        const output = await this.engine({ ...input, dependencyFiles: dependencies.files, dependencyLock: dependencies.lock }, signal);
        signal.throwIfAborted();
        record = await this.store.publish(project, id, snapshot.definitionHash, snapshot.hashes, output);
      }
      await this.workspace.withProject(project.definition.id, async current => {
        signal.throwIfAborted(); await assertSource(current, snapshot.hashes, snapshot.definitionHash);
        signal.throwIfAborted();
        await this.store.activate(current, record!);
        if (generation !== this.generation || this.closed) return;
        this.active = { project: current, record: record! }; this.status = { status: 'ready', error: null }; this.changed();
      });
    } catch (error) {
      if (signal.aborted && !timedOut || generation !== this.generation || this.closed) return;
      this.status = { status: 'failed', error: timedOut ? '工程显示构建超时，请重试。' : error instanceof BuildFailure ? error.logs.map(log => log.message).join('\n').slice(0, 2000)
        : error instanceof Error ? error.message.slice(0, 2000) : '工程显示无法构建，请检查源码后重试。' };
      this.changed();
    } finally { release?.(); clearTimeout(timer); }
  }
  async serve(rawUrl: string): Promise<Response> {
    const active = this.active;
    return active ? this.store.serve(active.project, active.record, rawUrl) : new Response('工程正在加载。', { status: 404 });
  }
  async stop(): Promise<void> {
    this.generation++; const job = this.job; job?.controller.abort();
    if (job) await job.done;
    this.active = null; this.status = undefined;
  }
  async dispose(): Promise<void> { this.closed = true; await this.stop(); }
}
