import type { JsonRpcMessage } from '@earendil-works/pi-mcp';
import { McpConnectionError } from './connection-errors.js';

/** Keeps a delayed HTTP/auth send tied to the exact live tool invocation. */
export class McpInvocationGate {
  private current: { check(): void; id?: string | number; sent: boolean } | undefined;
  begin(check: () => void): () => void {
    if (this.current) throw new McpConnectionError('UNAVAILABLE');
    const current = { check, sent: false }; this.current = current;
    return () => { if (this.current === current) this.current = undefined; };
  }
  dispatch(message: JsonRpcMessage): void {
    if (!('method' in message) || !['tools/call', 'resources/read'].includes(message.method) || !('id' in message)) return;
    if (!this.current || this.current.id !== undefined) throw new McpConnectionError('TARGET_DENIED');
    this.current.check(); this.current.id = message.id;
  }
  beforeHttp(id: string | number): void {
    const current = this.current;
    if (!current || current.id !== id || current.sent) throw new McpConnectionError('TARGET_DENIED');
    current.check(); current.sent = true;
  }
}
