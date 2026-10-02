import { contextBridge, ipcRenderer } from 'electron';
import type { HostApi } from '../shared/contracts';

const api: HostApi = {
  tools: () => ipcRenderer.invoke('host:tools'),
  storage: (toolId, request) => ipcRenderer.invoke('host:storage', toolId, request),
};

contextBridge.exposeInMainWorld('dreamEdge', api);
