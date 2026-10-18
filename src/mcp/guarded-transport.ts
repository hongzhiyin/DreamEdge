import type { McpTransport, JsonRpcMessage } from '@earendil-works/pi-mcp';
import { McpConnectionError } from './connection-errors.js';
/** Adds host checks and aggregate discovery budgets; framing/pagination stay in Pi. */
export class GuardedMcpTransport implements McpTransport {
  private bytes: number | undefined;
  private counts = { tools: 0, resources: 0, resourceTemplates: 0 };
  constructor(private readonly inner: McpTransport, private readonly check: () => void, private readonly fail: (error: unknown) => void,
    private readonly beforeSend?: (message: JsonRpcMessage) => void) {}
  beginCatalog(): void { this.bytes = 0; this.counts = { tools: 0, resources: 0, resourceTemplates: 0 }; }
  endCatalog(): void { this.bytes = undefined; }
  async start(): Promise<void> { this.check(); await this.inner.start(); }
  async send(message: JsonRpcMessage): Promise<void> { this.check(); this.beforeSend?.(message); await this.inner.send(message); }
  close(): Promise<void> { return this.inner.close(); }
  setProtocolVersion(version: string): void { this.inner.setProtocolVersion?.(version); }
  onClose(listener: () => void) { return this.inner.onClose(listener); }
  onError(listener: (error: Error) => void) { return this.inner.onError(listener); }
  onMessage(listener: (message: JsonRpcMessage) => void) {
    return this.inner.onMessage(message => {
      try {
        this.check();
        if (this.bytes !== undefined) {
          this.bytes += Buffer.byteLength(JSON.stringify(message));
          if (this.bytes > 4 * 1024 * 1024) throw new McpConnectionError('LIMIT_EXCEEDED');
          const result = 'result' in message && message.result && typeof message.result === 'object' ? message.result as Record<string, unknown> : {};
          for (const key of ['tools', 'resources', 'resourceTemplates'] as const) {
            if (Array.isArray(result[key])) this.counts[key] += result[key].length;
            if (this.counts[key] > (key === 'tools' ? 256 : 128)) throw new McpConnectionError('LIMIT_EXCEEDED');
          }
        }
        listener(message);
      } catch (error) { this.fail(error); }
    });
  }
}
