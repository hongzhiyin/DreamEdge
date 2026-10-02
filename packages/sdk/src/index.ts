import { SHELL_ORIGIN, TOOL_CHANNEL, type BridgeRequest, type Json, type StoredRecord } from './contracts.js';
export type { Json, AppManifest, ToolManifest, StoredRecord, StorageRequest, StorageClient } from './contracts.js';
export type { ProjectDefinition, WorkspaceProject, WorkspaceStatus, WorkspaceFile, WorkspaceRequest, WorkspaceResult } from './workspace.js';
export type * from './development.js';
export type * from './build.js';
export type * from './versions.js';
export type * from './windows.js';
type Pending = { resolve(value: unknown): void; reject(error: Error): void; timer: number };
const pending = new Map<string, Pending>();
if (typeof window !== 'undefined') {
  window.addEventListener('message', event => {
    if (event.source !== window.parent || event.origin !== SHELL_ORIGIN) return;
    const data = event.data;
    if (!data || data.channel !== TOOL_CHANNEL || data.type !== 'response') return;
    const request = pending.get(data.requestId);
    if (!request) return;
    clearTimeout(request.timer);
    pending.delete(data.requestId);
    if (data.error) request.reject(new Error(String(data.error)));
    else request.resolve(data.result);
  });
}
function request<T>(payload: BridgeRequest): Promise<T> {
  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID();
    const timer = window.setTimeout(() => {
      pending.delete(requestId);
      reject(new Error('响应超时，请重试并核对操作结果。'));
    }, 25000);
    pending.set(requestId, { resolve: value => resolve(value as T), reject, timer });
    window.parent.postMessage({ channel: TOOL_CHANNEL, type: 'request', requestId, request: payload }, SHELL_ORIGIN);
  });
}
export const storage = {
  list: (collection: string) => request<StoredRecord[]>({ kind: 'storage', payload: { operation: 'list', collection } }),
  put: (collection: string, id: string, value: Json) => request<void>({ kind: 'storage', payload: { operation: 'put', collection, id, value } }),
  remove: (collection: string, id: string) => request<void>({ kind: 'storage', payload: { operation: 'remove', collection, id } }),
};
export function callService<T>(service: string, method: string, input: Json = null): Promise<T> {
  return request<T>({ kind: 'service', service, method, input });
}
