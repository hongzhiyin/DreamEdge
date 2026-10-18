/** Deliver invalidations after commands and transactions finish, without reentrant mutations. */
export class ChangeFeed {
  private readonly listeners = new Set<(sessionId: string) => void>();
  private readonly pending = new Set<string>();
  private scheduled = false;

  subscribe(listener: (sessionId: string) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  notify(id: string): void {
    this.pending.add(id);
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      const ids = [...this.pending]; this.pending.clear();
      for (const sessionId of ids) for (const listener of [...this.listeners]) {
        try { listener(sessionId); } catch { /* View observers cannot interrupt host operations. */ }
      }
    });
  }

  clear(): void { this.listeners.clear(); this.pending.clear(); }
}
