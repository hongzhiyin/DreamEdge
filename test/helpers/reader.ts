import type { ReaderClient, ReaderInput, ReaderReply } from '../../src/reading/protocol.js';
export class FixtureReader implements ReaderClient {
  session = { sessionId: 'window', bookId: 'book', title: 'Test book', page: 1, contextVersion: 'v1', ready: true };
  calls: { operation: string; input: ReaderInput }[] = [];
  respond?: (operation: string, input: ReaderInput) => ReaderReply | undefined;
  async call(operation: string, input: ReaderInput): Promise<ReaderReply> {
    this.calls.push({ operation, input });
    const custom = this.respond?.(operation, input); if (custom) return custom;
    if (operation === 'sessions.list') return { ok: true, data: [this.session] };
    if (operation === 'page.read') return { ok: true, data: { ...this.session, page: input.params.page, assetHash: 'hash', rawText: 'A unique original passage. Another sentence.' } };
    if (operation === 'notes.create') return { ok: true, data: { created: true, note: { id: 'note', bookId: 'book', revision: 1, ...input.params } } };
    if (operation === 'notes.get') return { ok: true, data: { id: 'note', bookId: 'book', revision: 1 } };
    if (operation === 'notes.list') return { ok: true, data: [{ id: 'note', title: 'Test note' }] };
    if (operation === 'requests.get') return { ok: true, data: { status: 'unknown' } };
    return { ok: true, data: { id: 'citation', ...input.params } };
  }
}
