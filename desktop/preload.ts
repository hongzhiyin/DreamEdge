import type { FileScopeCommand } from '../src/files/scope-command.js';
import { contextBridge, ipcRenderer } from 'electron';
import type { ChatAck, ChatBootstrap, ChatBridge, ChatCatchup, ChatCommand, ChatReply, ChatSession } from '../src/chat/types.js';

async function call<T>(command: ChatCommand): Promise<T> {
  const reply = await ipcRenderer.invoke('dreamedge:chat', command) as ChatReply<T>;
  if (!reply.ok) throw new Error(reply.error.message);
  return reply.data;
}

async function fileCall<T>(command: FileScopeCommand): Promise<T> {
  const reply = await ipcRenderer.invoke('dreamedge:file-scopes', command) as ChatReply<T>;
  if (!reply.ok) throw new Error(reply.error.message);
  return reply.data;
}

const bridge: ChatBridge = {
  fileScopes: sessionId => fileCall({ type: 'snapshot', sessionId }),
  chooseDirectory: (sessionId, options) => fileCall({ type: 'choose', sessionId, options }),
  revokeDirectory: (sessionId, grantId) => fileCall({ type: 'revoke', sessionId, grantId }),
  setDeviceAccess: (sessionId, enabled) => fileCall({ type: 'device', sessionId, enabled }),
  initialize: () => call<ChatBootstrap>({ type: 'initialize' }),
  createSession: () => call<ChatSession>({ type: 'create' }),
  watch: (sessionId, cursor) => call<ChatCatchup>({ type: 'watch', sessionId, ...(cursor ? { cursor } : {}) }),
  send: input => call<ChatAck>({ type: 'send', input }),
  stop: (sessionId, runId) => call<void>({ type: 'stop', sessionId, runId }),
  retry: (sessionId, runId, mode) => call<ChatAck>({ type: 'retry', sessionId, runId, ...(mode ? { mode } : {}) }),
  resumeBatch: reference => call<ChatAck>({ type: 'resumeBatch', reference }),
  decideApproval: decision => call<void>({ type: 'approval', decision }),
  retrySave: sessionId => call<void>({ type: 'retrySave', sessionId }),
  subscribe: listener => {
    const handler = (_event: unknown, update: Parameters<typeof listener>[0]) => listener(update);
    ipcRenderer.on('dreamedge:update', handler);
    return () => { ipcRenderer.removeListener('dreamedge:update', handler); };
  },
  onVisible: listener => {
    const handler = () => listener();
    ipcRenderer.on('dreamedge:visible', handler);
    return () => { ipcRenderer.removeListener('dreamedge:visible', handler); };
  },
};
contextBridge.exposeInMainWorld('dreamedge', bridge);

contextBridge.exposeInMainWorld('dreamedgeMcp', { request: async (command: unknown) => {
  const reply = await ipcRenderer.invoke('dreamedge:mcp', command) as ChatReply<unknown>;
  if (!reply.ok) throw new Error(reply.error.message); return reply.data;
} });
