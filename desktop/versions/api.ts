import { randomUUID } from 'node:crypto';
import type { VersionOperation, VersionRequest, VersionResult, WorkspaceProject } from '../../shared/contracts';
import { shortText } from '../development/context';
import { WorkspaceApi } from '../workspace/api';
import { currentVersionState } from './current';
import { planSave, saveVersion, type ChangeRequest, type SavePlan } from './save';
import { VersionStore } from './store';
import type { SaveHook } from './transaction';

interface Job { project: WorkspaceProject; controller: AbortController; done: Promise<void> }
export class VersionsApi {
  private readonly store = new VersionStore();
  private readonly jobs = new Map<string, Job>();
  private closed = false;
  constructor(private readonly workspace: WorkspaceApi, private readonly dataDirectory: string,
    private readonly hook?: SaveHook, private readonly timeoutMs = 30000) {}
  async execute(input: unknown): Promise<VersionResult> {
    if (this.closed) throw new Error('版本服务已关闭。');
    const request = structuredClone(input) as VersionRequest;
    if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('无效的版本请求。');
    if (request.operation === 'confirm' || request.operation === 'restore') return this.start(request);
    if (request.operation === 'cancel') return this.cancel(request.projectId, request.operationId);
    return this.workspace.withProject(request.projectId, async project => {
      if (request.operation === 'getOperation') return structuredClone(await this.operation(project, request.operationId));
      if (request.operation !== 'status') throw new Error('不支持的版本操作。');
      const current = await currentVersionState(project); const history = await this.store.history(project);
      const versions = [];
      for (const entry of history.entries) versions.push(await this.store.record(project, entry));
      return structuredClone({ stateHash: current.stateHash, head: history.head, versions });
    });
  }
  private async operation(project: WorkspaceProject, id: string): Promise<VersionOperation> {
    const operation = await this.store.operation(project, id);
    if (operation.status === 'running' && !this.jobs.has(id)) {
      const history = await this.store.history(project);
      const entry = history.entries.find(entry => entry.id === operation.versionId);
      const committed = entry && (await this.store.record(project, entry)).operationId === operation.id;
      operation.status = committed ? 'completed' : 'interrupted'; operation.finishedAt = new Date().toISOString();
      operation.error = committed ? null : '上次版本操作已中断；工程已按事务记录恢复，请重新核对后操作。';
      if (!committed) { operation.versionId = null; operation.checkpointId = null; }
      await this.store.saveOperation(project, operation);
    }
    return operation;
  }
  private async start(request: ChangeRequest): Promise<VersionOperation> {
    const label = shortText(request.label, '版本名称', 160);
    const started = await this.workspace.withProject(request.projectId, async project => {
      if (this.closed || this.jobs.size) throw new Error('版本服务正在关闭或已有运行中的保存操作。');
      const plan = await planSave(project, request);
      const operation: VersionOperation = { schemaVersion: 1, id: randomUUID(), projectId: project.definition.id,
        kind: request.operation, status: 'running', startedAt: new Date().toISOString(), finishedAt: null,
        versionId: null, checkpointId: null, error: null };
      await this.store.createOperation(project, operation);
      const job: Job = { project, controller: new AbortController(), done: Promise.resolve() };
      this.jobs.set(operation.id, job);
      return { project, plan, operation, job };
    });
    started.job.done = this.run(started.project, started.plan, started.operation, label, started.job);
    return structuredClone(started.operation);
  }
  private async run(project: WorkspaceProject, plan: SavePlan, operation: VersionOperation, label: string, job: Job): Promise<void> {
    const timer = setTimeout(() => job.controller.abort('timeout'), this.timeoutMs);
    try {
      await this.workspace.mutateProject(project.definition.id, current => saveVersion(current, this.dataDirectory,
        operation, plan, label, job.controller.signal, this.hook));
      operation.status = 'completed';
    } catch {
      const history = await this.store.history(project).catch(() => null);
      if (operation.versionId && history?.entries.some(entry => entry.id === operation.versionId)) operation.status = 'completed';
      else {
        operation.status = job.controller.signal.reason === 'cancelled' ? 'cancelled' : 'failed';
        operation.error = job.controller.signal.reason === 'timeout' ? '版本操作准备超时；源码未提交。'
          : '版本操作已取消或失败；请重新核对工程状态，未完成的事务备份会保留。';
        operation.versionId = null; operation.checkpointId = null;
      }
    } finally {
      clearTimeout(timer); operation.finishedAt = new Date().toISOString();
      await this.workspace.exclusive(async () => { await this.store.saveOperation(project, operation).catch(() => {}); this.jobs.delete(operation.id); });
    }
  }
  private async cancel(projectId: string, id: string): Promise<VersionOperation> {
    const job = this.jobs.get(id);
    if (job && job.project.definition.id !== projectId) throw new Error('版本操作不属于指定工程。');
    if (job) { job.controller.abort('cancelled'); await job.done; }
    return this.workspace.withProject(projectId, async project => structuredClone(await this.operation(project, id)));
  }
  async dispose(): Promise<void> {
    this.closed = true;
    // Abort before waiting for the workspace queue, which may be preparing a transaction.
    for (const job of this.jobs.values()) job.controller.abort('closed');
    const jobs = await this.workspace.exclusive(async () => [...this.jobs.values()]);
    for (const job of jobs) job.controller.abort('closed');
    await Promise.all(jobs.map(job => job.done));
  }
}
