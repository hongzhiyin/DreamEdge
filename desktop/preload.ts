import { contextBridge, ipcRenderer } from 'electron';
import type { HostApi } from '../shared/contracts';

async function invoke<T>(channel: string, ...arguments_: unknown[]): Promise<T> {
  const response = await ipcRenderer.invoke(channel, ...arguments_);
  if (!response?.ok) throw new Error(response?.error || '应用操作失败，请重试。');
  return response.result as T;
}
const api: HostApi = {
  versions: request => invoke('host:versions', request),
  build: request => invoke('host:build', request),
  development: request => invoke('host:development', request),
  workspace: request => invoke('host:workspace', request),
  info: () => invoke('host:info'),
  service: (toolId, service, method, input) => invoke('host:service', toolId, service, method, input),
  tools: () => invoke('host:tools'),
  storage: (toolId, request) => invoke('host:storage', toolId, request),
};

contextBridge.exposeInMainWorld('dreamEdge', api);
