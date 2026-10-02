import type { WorkspaceProject, WorkspaceRequest, WorkspaceResult } from '../../shared/contracts';
import { WorkspaceManager } from './manager';
import { WorkspaceFiles } from './files';

export class WorkspaceApi {
  private readonly manager: WorkspaceManager;
  private readonly files: WorkspaceFiles;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(dataDirectory: string, frameworkRoot: string) {
    this.manager = new WorkspaceManager(dataDirectory, frameworkRoot);
    this.files = new WorkspaceFiles(this.manager);
  }
  execute(input: unknown): Promise<WorkspaceResult> {
    let request: unknown;
    try { request = structuredClone(input); }
    catch { return Promise.reject(new Error('工作区请求必须是可序列化的数据。')); }
    return this.exclusive(async () => structuredClone(await this.dispatch(request)));
  }
  exclusive<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(task);
    this.queue = result.catch(() => {});
    return result;
  }
  withProject<T>(id: unknown, task: (project: WorkspaceProject) => Promise<T>): Promise<T> {
    return this.exclusive(async () => task(structuredClone(await this.manager.project(id))));
  }
  private async dispatch(input: unknown): Promise<WorkspaceResult> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('无效的工作区请求。');
    const request = input as WorkspaceRequest;
    switch (request.operation) {
      case 'current': return this.manager.current();
      case 'create': return this.manager.create(request.directory, request.name);
      case 'open': return this.manager.open(request.directory);
      case 'close': return this.manager.close();
      case 'save': return this.manager.save(request.projectId, request);
      case 'listFiles': return this.files.list(request.projectId);
      case 'readFile': return this.files.read(request.projectId, request.path);
      case 'writeFile': return this.files.write(request.projectId, request.path, request.content, request.expectedHash);
      default: throw new Error('不支持的工作区操作。');
    }
  }
}
