import { readFileSync, lstatSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { ReaderBinding, ReaderRequest } from './protocol.js';
interface State { format: 'dreamedge-reader/v1'; bindings: Record<string, ReaderBinding>; requests: ReaderRequest[] }
/** Host-owned persistence, separate from transport client IDs; unknown requests survive restarts. */
export class ReaderStore {
  private state: State = { format: 'dreamedge-reader/v1', bindings: {}, requests: [] };
  constructor(private readonly path?: string) {
    if (!path) return;
    try {
      if (lstatSync(path).isSymbolicLink()) throw new Error('Unsafe settings');
      const value = JSON.parse(readFileSync(path, 'utf8')) as State;
      if (value.format !== 'dreamedge-reader/v1' || !value.bindings || Array.isArray(value.bindings)
        || !Array.isArray(value.requests) || value.requests.length > 256) throw new Error('Invalid settings');
      for (const binding of Object.values(value.bindings)) if (!binding.readerSessionId || !binding.bookId || !binding.destination
        || !Array.isArray(binding.selectedNotes)) throw new Error('Invalid binding');
      for (const request of value.requests) if (!request.requestId || !request.chatId || !request.input
        || !['pending', 'complete', 'uncertain'].includes(request.status)) throw new Error('Invalid request');
      this.state = value;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('阅读器绑定或请求记录无效。'); }
  }
  binding(chatId: string) { return structuredClone(this.state.bindings[chatId]); }
  bind(chatId: string, binding?: ReaderBinding) {
    const next = structuredClone(this.state); if (binding) next.bindings[chatId] = binding; else delete next.bindings[chatId]; this.save(next);
  }
  requests(chatId: string, bookId: string) { return structuredClone(this.state.requests.filter(r => r.chatId === chatId && r.bookId === bookId)); }
  record(request: ReaderRequest) {
    const next = structuredClone(this.state); const index = next.requests.findIndex(r => r.requestId === request.requestId);
    if (index >= 0) next.requests[index] = structuredClone(request);
    else { if (next.requests.length >= 256) { const finished = next.requests.findIndex(r => r.status === 'complete');
      if (finished < 0) throw new Error('请先核对未决阅读器请求。'); next.requests.splice(finished, 1); }
      next.requests.push(structuredClone(request)); }
    this.save(next);
  }
  private save(next: State) {
    if (this.path) {
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      try { writeFileSync(temporary, JSON.stringify(next), { mode: 0o600, flag: 'wx' }); renameSync(temporary, this.path); }
      finally { try { unlinkSync(temporary); } catch { /* Already renamed. */ } }
    }
    this.state = next;
  }
}
