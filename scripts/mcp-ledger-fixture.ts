import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { officialMcp } from './mcp-official.js';
/** Independent, disposable inventory app implemented with the official server SDK, not DreamEdge adapters. */
export async function ledgerFixture(sdkRoot: string, directory: string) {
  const sdk = await officialMcp(sdkRoot);
  const entries: string[] = []; let reads = 0;
  const sessions = new Map<string, { transport: any; server: any }>();
  const makeServer = () => {
    const server = new sdk.McpServer({ name: 'AcceptanceLedger', version: '1.0.0' });
    server.registerTool('record_entry', { description: 'Append exactly one entry to the isolated acceptance ledger. hold=true writes then waits, for controlled interruption testing.',
      inputSchema: { label: sdk.z.string().min(1).max(80), hold: sdk.z.boolean().optional() } }, async (args: { label: string; hold?: boolean }, extra: { signal: AbortSignal }) => {
      entries.push(args.label); await writeFile(join(directory, 'ledger.json'), JSON.stringify(entries));
      if (args.hold) await new Promise<void>((resolve, reject) => {
        extra.signal.addEventListener('abort', () => reject(new Error('Interrupted after commit')), { once: true });
        if (extra.signal.aborted) reject(new Error('Interrupted')); // No synthetic success receipt.
      });
      return { content: [{ type: 'text', text: `recorded:${args.label}` }], structuredContent: { count: entries.length } };
    });
    server.registerResource('inventory', 'ledger://inventory', { description: 'Acceptance-only inventory', mimeType: 'text/plain' }, async () => {
      reads++; return { contents: [{ uri: 'ledger://inventory', mimeType: 'text/plain', text: 'Inventory verification code: COBALT-4826. Stock: 42.' }] };
    }); return server;
  };
  const http = createServer((req, res) => { void (async () => {
    if (req.url !== '/mcp') { res.writeHead(404); res.end(); return; }
    let session = sessions.get(String(req.headers['mcp-session-id'] ?? ''));
    if (!session) {
      if (req.method !== 'POST') { res.writeHead(404); res.end(); return; }
      const server = makeServer(); let transport: any;
      transport = new sdk.StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID,
        onsessioninitialized: (id: string) => sessions.set(id, { transport, server }) });
      await server.connect(transport); session = { server, transport };
    }
    await session.transport.handleRequest(req, res);
  })().catch(() => { if (!res.headersSent) res.writeHead(500); res.end(); }); });
  await new Promise<void>((resolve, reject) => { http.once('error', reject); http.listen(0, '127.0.0.1', () => resolve()); });
  const address = http.address(); if (!address || typeof address === 'string') throw new Error('No ledger address');
  return { url: `http://127.0.0.1:${address.port}/mcp`, entries, reads: () => reads,
    close: async () => { for (const session of sessions.values()) await session.server.close().catch(() => {});
      http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve())); } };
}
