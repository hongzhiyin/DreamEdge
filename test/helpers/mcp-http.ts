import { createServer } from 'node:http';
import type { ServerResponse } from 'node:http';
import type { TestContext } from 'node:test';
import { catalogTool } from './mcp-connection.js';
export async function mcpHttpFixture(t: TestContext, options: { streams?: boolean; bearer?: string } = {}) {
  const requests: { method: string; rpc?: string; authorization?: string; session?: string; lastEventId?: string }[] = [];
  const streams = new Set<ServerResponse>(); let sequence = 0, nextSession = 0;
  const state = { toolName: 'first', expired: false, rejectAuth: false, redirect: '', errorBody: '', oversized: false, listCount: 0 };
  const sessions = new Set<string>();
  const server = createServer(async (req, res) => {
    const record: (typeof requests)[number] = { method: req.method ?? '', ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}),
      ...(req.headers['mcp-session-id'] ? { session: String(req.headers['mcp-session-id']) } : {}),
      ...(req.headers['last-event-id'] ? { lastEventId: String(req.headers['last-event-id']) } : {}) };
    requests.push(record);
    const json = (status: number, value: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (state.redirect) { res.writeHead(302, { location: state.redirect }); res.end(); return; }
    if (state.errorBody) { res.writeHead(500, { 'Content-Type': 'text/plain' }); res.end(state.errorBody); return; }
    if (state.rejectAuth || (options.bearer && req.headers.authorization !== `Bearer ${options.bearer}`)) {
      res.writeHead(401, { 'WWW-Authenticate': 'Bearer', 'Content-Type': 'text/plain' }); res.end('fixture-token must not leak'); return;
    }
    if (req.method === 'DELETE') { sessions.delete(record.session ?? ''); res.writeHead(204); res.end(); return; }
    if (req.method === 'GET') {
      if (state.expired) { json(404, {}); return; }
      if (!options.streams) { res.writeHead(405); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive' }); res.write(': connected\n\n');
      streams.add(res); res.on('close', () => streams.delete(res)); return;
    }
    let data = ''; for await (const part of req) data += part;
    const request = JSON.parse(data) as { method: string; id?: number }; record.rpc = request.method;
    if (request.method === 'initialize') {
      const session = `fixture-${++nextSession}`; sessions.add(session); res.setHeader('Mcp-Session-Id', session);
      json(200, { jsonrpc: '2.0', id: request.id, result: { protocolVersion: '2025-11-25', serverInfo: { name: 'http-fixture', version: '1' },
        capabilities: { tools: { listChanged: true }, resources: { listChanged: true } } } }); return;
    }
    if (state.expired || !sessions.has(record.session ?? '')) { json(404, {}); return; }
    if (request.id === undefined) { res.writeHead(202); res.end(); return; }
    if (request.method === 'tools/list') state.listCount++;
    const result = request.method === 'tools/list' ? { tools: [catalogTool(state.toolName)] }
      : request.method === 'tools/call' ? { content: [{ type: 'text', text: 'http tool executed' }], structuredContent: { ok: true } }
      : request.method === 'resources/read' ? { contents: [{ uri: 'fixture://document', text: 'http resource text' }] }
      : request.method === 'resources/list' ? { resources: [{ uri: 'fixture://document', name: 'Document' }] } : { resourceTemplates: [] };
    if (state.oversized && request.method === 'tools/list') {
      json(200, { jsonrpc: '2.0', id: request.id, result: { tools: [{ ...catalogTool(), description: 'x'.repeat(1024 * 1024 + 100) }] } }); return;
    }
    json(200, { jsonrpc: '2.0', id: request.id, result });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
  const address = server.address(); if (!address || typeof address === 'string') throw 0;
  t.after(async () => { for (const res of streams) res.destroy(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  return { url: `http://127.0.0.1:${address.port}/mcp`, state, requests, streams,
    notify: () => { for (const res of streams) res.write(`id: ${++sequence}\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })}\n\n`); return String(sequence); },
    drop: () => { for (const res of streams) res.destroy(); } };
}
