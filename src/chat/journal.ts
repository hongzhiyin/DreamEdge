import { randomUUID } from 'node:crypto';
import type { ChatCatchup, ChatCursor, ChatEvent, ChatView } from './types.js';

export class ChatJournal {
  private readonly epoch = randomUUID();
  private readonly events: ChatEvent[] = [];
  private sequence = 0;
  private serialized = '';

  constructor(private readonly limit: number) {}

  publish(view: ChatView): ChatEvent | undefined {
    const serialized = JSON.stringify(view);
    if (serialized === this.serialized) return;
    this.serialized = serialized;
    const event: ChatEvent = { sessionId: view.sessionId, epoch: this.epoch, sequence: ++this.sequence,
      view: structuredClone(view) };
    this.events.push(event);
    if (this.events.length > this.limit) this.events.shift();
    return structuredClone(event);
  }

  catchup(cursor?: ChatCursor): ChatCatchup {
    const latest = this.events.at(-1);
    if (!latest) throw new Error('Chat journal has no snapshot');
    const oldest = this.events[0]!.sequence;
    if (!cursor || cursor.epoch !== this.epoch || cursor.sequence < oldest - 1 || cursor.sequence > latest.sequence) {
      return { kind: 'snapshot', event: structuredClone(latest) };
    }
    return { kind: 'replay', events: structuredClone(this.events.filter(event => event.sequence > cursor.sequence)) };
  }
}
