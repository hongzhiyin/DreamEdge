import type { SessionStore } from '../storage/types.js';
import { ConversationError } from './state.js';
import type { SessionState } from './state.js';

/** Coordinates durable boundaries, coalesced checkpoints and explicit save retries. */
export class SessionPersistence {
  private readonly timers = new Map<SessionState, ReturnType<typeof setTimeout>>();
  private readonly waiting = new Map<SessionState, Set<() => void>>();
  private closed = false;

  constructor(readonly store: SessionStore | undefined, private readonly checkpointMs = 250) {
    if (!Number.isSafeInteger(checkpointMs) || checkpointMs < 1 || checkpointMs > 2_147_483_647) {
      throw new ConversationError('INVALID_COMMAND', '检查点间隔必须为有效毫秒数。');
    }
  }

  canStart(state: SessionState): boolean {
    return state.saveState.status === 'disabled' || state.saveState.status === 'saved';
  }

  changed(state: SessionState): void {
    if (!this.store || this.closed || state.saveState.status === 'failed') return;
    state.saveState.status = 'pending';
    if (!this.timers.has(state)) {
      const timer = setTimeout(() => { this.timers.delete(state); this.flush(state); }, this.checkpointMs);
      timer.unref();
      this.timers.set(state, timer);
    }
  }

  flush(state: SessionState, retry = false): boolean {
    if (this.closed) throw new ConversationError('SERVICE_CLOSED', '会话数据库已关闭。');
    this.clearTimer(state);
    if (!this.store) return true;
    if (state.saveState.status === 'failed' && !retry) return false;
    if (state.saveState.status === 'saved' && state.saveState.savedVersion === state.session.version) return true;
    state.saveState.status = 'pending';
    try {
      this.store.save(structuredClone({ session: state.session, messages: state.messages, runs: state.runs }),
        state.saveState.savedVersion);
      state.saveState = { status: 'saved', savedVersion: state.session.version };
      state.notify();
      for (const resume of this.waiting.get(state) ?? []) resume();
      return true;
    } catch {
      state.saveState = { status: 'failed', savedVersion: state.saveState.savedVersion,
        error: { code: 'SAVE_FAILED', message: '保存失败；内容保留在内存中，请重试保存。' } };
      state.notify();
      return false;
    }
  }

  /** The caller must update the version first; this barrier never repeats a model/tool action. */
  commit(state: SessionState, signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return Promise.resolve(false);
    const version = state.session.version;
    this.flush(state);
    return this.waitForSave(state, signal, version);
  }

  waitForSave(state: SessionState, signal: AbortSignal, version = state.session.version): Promise<boolean> {
    if (signal.aborted) return Promise.resolve(false);
    const saved = () => state.saveState.status === 'disabled'
      || (state.saveState.status === 'saved' && state.saveState.savedVersion !== null && state.saveState.savedVersion >= version);
    if (saved()) return Promise.resolve(true);
    return new Promise(resolve => {
      const listeners = this.waiting.get(state) ?? new Set<() => void>();
      const finish = (ready: boolean) => {
        listeners.delete(resume);
        if (!listeners.size) this.waiting.delete(state);
        signal.removeEventListener('abort', abort);
        resolve(ready);
      };
      const resume = () => { if (saved()) finish(true); };
      const abort = () => finish(false);
      listeners.add(resume); this.waiting.set(state, listeners);
      signal.addEventListener('abort', abort, { once: true });
    });
  }

  close(states: Iterable<SessionState>): void {
    const saved = [...states].map(state => this.flush(state));
    if (saved.some(result => !result)) {
      throw new ConversationError('SAVE_FAILED', '存在未保存内容；重试保存后再关闭。');
    }
    this.store?.close();
    this.closed = true;
  }

  private clearTimer(state: SessionState): void {
    clearTimeout(this.timers.get(state));
    this.timers.delete(state);
  }
}
