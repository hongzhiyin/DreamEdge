import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { mkdir } from 'node:fs/promises';
import type { WindowBounds, WorkspaceProject } from '../../shared/contracts';
import { identifier } from '../development/sessions';
import { directory, readText, writeText } from '../workspace/paths';
import type { Entry } from '../workspace/registry';

export interface WindowRecord { id: string; project: Entry | null; bounds: WindowBounds | null; open: boolean }
interface State { schemaVersion: 1; windows: WindowRecord[] }
export class ProjectAlreadyOpen extends Error {
  constructor(readonly windowId: string) { super('工程已在另一个开发窗口打开。'); }
}
function validBounds(value: WindowBounds): boolean {
  return value && ['x', 'y', 'width', 'height'].every(key => Number.isSafeInteger(value[key as keyof WindowBounds]))
    && Math.abs(value.x) <= 100000 && Math.abs(value.y) <= 100000 && value.width >= 320 && value.width <= 10000 && value.height >= 240 && value.height <= 10000;
}
export class WindowState {
  private state: State = { schemaVersion: 1, windows: [] };
  private queue: Promise<unknown> = Promise.resolve();
  readonly ready: Promise<void>;
  constructor(private readonly dataDirectory: string) { this.ready = this.load(); }
  private async load(): Promise<void> {
    await mkdir(this.dataDirectory, { recursive: true });
    await directory(this.dataDirectory);
    let content: string;
    try { content = await readText(this.dataDirectory, 'windows-state.json'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    const value = JSON.parse(content) as State;
    if (!value || value.schemaVersion !== 1 || !Array.isArray(value.windows) || value.windows.length > 100
        || new Set(value.windows.map(window => window?.id)).size !== value.windows.length) throw new Error('窗口恢复记录无效。');
    for (const window of value.windows) {
      identifier(window.id);
      if (typeof window.open !== 'boolean' || (window.bounds !== null && !validBounds(window.bounds))) throw new Error('窗口恢复参数无效。');
      if (window.project !== null) {
        identifier(window.project.id);
        if (typeof window.project.root !== 'string' || !isAbsolute(window.project.root)) throw new Error('窗口工程路径无效。');
      }
    }
    const active = value.windows.filter(window => window.open && window.project);
    if (value.windows.filter(window => window.open).length > 8
        || new Set(active.map(window => window.project!.id)).size !== active.length) throw new Error('窗口恢复记录包含重复工程或超出窗口限制。');
    this.state = value;
  }
  async records(): Promise<WindowRecord[]> { await this.ready; await this.queue; return structuredClone(this.state.windows); }
  async record(id: string): Promise<WindowRecord> {
    const record = (await this.records()).find(window => window.id === id);
    if (!record) throw new Error('开发窗口不存在。'); return record;
  }
  private mutate<T>(change: (windows: WindowRecord[]) => T): Promise<T> {
    const result = this.queue.then(async () => {
      await this.ready; const windows = structuredClone(this.state.windows); const output = change(windows);
      await writeText(this.dataDirectory, 'windows-state.json', JSON.stringify({ schemaVersion: 1, windows }));
      this.state = { schemaVersion: 1, windows }; return structuredClone(output);
    });
    this.queue = result.catch(() => {}); return result;
  }
  allocate(project: Entry | null = null, reuseId?: string): Promise<WindowRecord> {
    return this.mutate(windows => {
      if (windows.filter(window => window.open).length >= 8) throw new Error('最多同时打开八个开发窗口。');
      const existing = reuseId ? windows.find(window => window.id === reuseId && !window.open) : undefined;
      if (existing) { existing.open = true; return existing; }
      if (windows.length >= 100) throw new Error('当前最多保留 100 条窗口记录。');
      const record = { id: randomUUID(), project, bounds: null, open: true }; windows.push(record); return record;
    });
  }
  bind(id: string, project: WorkspaceProject | null): Promise<void> {
    return this.mutate(windows => {
      const window = windows.find(window => window.id === id && window.open);
      if (!window) throw new Error('开发窗口已关闭。');
      const other = project && windows.find(window => window.open && window.id !== id && window.project?.id === project.definition.id);
      if (other) throw new ProjectAlreadyOpen(other.id);
      window.project = project ? { id: project.definition.id, root: project.rootDirectory } : null;
    });
  }
  bounds(id: string, bounds: WindowBounds): Promise<void> {
    if (!validBounds(bounds)) return Promise.reject(new Error('窗口位置参数无效。'));
    return this.mutate(windows => { const window = windows.find(window => window.id === id); if (window) window.bounds = bounds; });
  }
  close(id: string): Promise<void> { return this.mutate(windows => { const window = windows.find(window => window.id === id); if (window) window.open = false; }); }
  discard(id: string): Promise<void> { return this.mutate(windows => { const index = windows.findIndex(window => window.id === id); if (index >= 0) windows.splice(index, 1); }); }
}
