import { SHELL_ORIGIN, TOOL_CHANNEL, type Json, type StoredRecord, type StorageRequest } from '../shared/contracts';
import { createId } from '../shared/create-id';

type Pending = { resolve(value: StoredRecord[] | void): void; reject(error: Error): void; timer: number };
const pending = new Map<string, Pending>();

window.addEventListener('keydown', event => {
  if (window.parent === window) return;
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    window.parent.postMessage({ channel: TOOL_CHANNEL, type: 'toggle-assistant' }, SHELL_ORIGIN);
  }
});

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

function request(payload: StorageRequest): Promise<StoredRecord[] | void> {
  return new Promise((resolve, reject) => {
    const requestId = createId();
    const timer = window.setTimeout(() => {
      pending.delete(requestId);
      reject(new Error('存储响应超时，请重新加载工具后核对记录。'));
    }, 10000);
    pending.set(requestId, { resolve, reject, timer });
    window.parent.postMessage({ channel: TOOL_CHANNEL, type: 'request', requestId, request: payload }, SHELL_ORIGIN);
  });
}

export const storage = {
  async list(collection: string): Promise<StoredRecord[]> {
    return (await request({ operation: 'list', collection })) as StoredRecord[];
  },
  async put(collection: string, id: string, value: Json): Promise<void> {
    await request({ operation: 'put', collection, id, value });
  },
  async remove(collection: string, id: string): Promise<void> {
    await request({ operation: 'remove', collection, id });
  },
};
