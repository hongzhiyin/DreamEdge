import { WebHandoffs, scopedChat } from './handoff.js';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, realpath } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import type { ChatHub } from '../src/chat/hub.js';
import type { ChatReply } from '../src/chat/types.js';
import { WebAuth, sameOrigin, type WebSession } from './auth.js';
import { browserIndex, pairingPage, pairingScript, webPolicy, webStyles } from './pages.js';
import { browserBridgeSource } from './browser-bridge.js';

type Handler = (command: unknown, clientId: string) => ChatReply<unknown> | Promise<ChatReply<unknown>>;
export interface WebHostOptions {
  hub: Pick<ChatHub, 'execute' | 'subscribe'>;
  rendererDirectory: string;
  port?: number;
  extensions?: Record<string, Handler>;
  extraScript?: string;
}
async function jsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (!request.headers['content-type']?.startsWith('application/json')) throw new Error('Invalid JSON');
  let size = 0; const chunks: Buffer[] = [];
  for await (const part of request) { const chunk = Buffer.from(part); size += chunk.length;
    if (size > 256 * 1024) throw new Error('Request too large'); chunks.push(chunk); }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid request');
  return value as Record<string, unknown>;
}
const json = (res: ServerResponse, status: number, value: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value));
};
const failure = (res: ServerResponse, status: number, message: string) => json(res, status, { ok: false, error: { code: 'WEB_REJECTED', message } });
const types: Record<string, string> = { '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
const client = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9-]{16,80}$/.test(value);

export async function startWebHost(options: WebHostOptions) {
  const auth = new WebAuth(), handoffs = new WebHandoffs();
  const valid = (session: WebSession) => auth.valid(session) || handoffs.valid(session);
  const root = await realpath(options.rendererDirectory);
  const streams = new Set<{ response: ServerResponse; session: WebSession; clientId: string }>();
  let origin = '', closing = false;
  const server = createServer((request, response) => { void route(request, response).catch(() => {
    if (!response.headersSent) failure(response, 400, '请求无效或操作未完成。'); else response.end();
  }); });
  server.requestTimeout = 15_000; server.headersTimeout = 10_000;
  const unsubscribe = options.hub.subscribe(event => {
    for (const stream of streams) {
      if (!valid(stream.session)) { stream.response.write('event: auth\ndata: {}\n\n'); stream.response.end(); continue; }
      if (stream.session!.watched.get(stream.clientId) === event.sessionId
        && !stream.response.write('data: ' + JSON.stringify(event) + '\n\n')) stream.response.end();
    }
  });
  const heartbeat = setInterval(() => {
    for (const stream of streams) {
      if (!valid(stream.session)) { stream.response.write('event: auth\ndata: {}\n\n'); stream.response.end(); }
      else if (!stream.response.write(': heartbeat\n\n')) stream.response.end();
    }
  }, 15_000); heartbeat.unref();
  async function route(req: IncomingMessage, res: ServerResponse) {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Content-Security-Policy', webPolicy);
    if (closing || !sameOrigin(req, origin, req.method === 'POST')) return failure(res, 403, '网页来源无效。');
    const url = new URL(req.url ?? '/', origin);
    if (req.method === 'POST' && url.pathname === '/api/pair') {
      const body = await jsonBody(req); const paired = auth.pair(body.code);
      if (!paired) return failure(res, 403, '配对码无效或已过期。');
      res.setHeader('Set-Cookie', paired.cookie); return json(res, 200, { ok: true, csrf: paired.csrf });
    }
    if (req.method === 'POST' && url.pathname === '/api/handoff') {
      const body = await jsonBody(req), exchanged = handoffs.exchange(body.ticket);
      return exchanged ? json(res, 200, { ok: true, ...exchanged }) : failure(res, 403, '入口已失效，请从业务应用重新打开。');
    }
    const scoped = handoffs.get(req.headers['x-dreamedge-handoff']);
    // A rejected scoped token must never fall back to a broader paired cookie.
    const session = req.headers['x-dreamedge-handoff'] !== undefined ? scoped : auth.session(req);
    if (req.method === 'GET' && ['/pair', '/pair.js', '/web.css'].includes(url.pathname)) {
      const payload = url.pathname === '/pair' ? pairingPage : url.pathname === '/pair.js' ? pairingScript : webStyles;
      res.setHeader('Content-Type', url.pathname === '/pair' ? 'text/html; charset=utf-8' : url.pathname.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8');
      res.end(payload); return;
    }
    if (!session && (url.pathname.startsWith('/api/') || url.pathname === '/')) {
      if (req.method === 'GET' && url.pathname === '/') { res.writeHead(302, { Location: '/pair' }); res.end(); return; }
      return failure(res, 401, '请先在桌面端配对。');
    }
    // Loopback cookies are shared across ports; an origin-scoped proof also protects reads.
    if (url.pathname.startsWith('/api/') && (!session || !auth.csrf(req, session))) return failure(res, 403, '网页请求校验失败。');
    if (req.method === 'GET' && url.pathname === '/api/session') return json(res, 200, { ok: true });
    if (req.method === 'GET' && url.pathname === '/api/events') {
      const id = url.searchParams.get('clientId');
      if (!client(id) || streams.size >= 32) return failure(res, 429, '网页连接数量已达上限。');
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive' }); res.write(': connected\n\n');
      const stream = { response: res, session: session!, clientId: id }; streams.add(stream);
      res.on('close', () => { streams.delete(stream); }); return;
    }
    if (req.method === 'POST' && (url.pathname === '/api/chat' || url.pathname.startsWith('/api/extension/'))) {
      const { clientId, command } = await jsonBody(req);
      if (!client(clientId)) return failure(res, 400, '网页会话无效。');
      if (scoped && url.pathname !== '/api/chat') return failure(res, 403, '内嵌会话不提供全局配置入口。');
      const key = url.pathname.slice('/api/extension/'.length);
      const handler = Object.hasOwn(options.extensions ?? {}, key) ? options.extensions![key] : undefined;
      if (url.pathname !== '/api/chat' && !handler) return failure(res, 404, '此能力尚未接入。');
      const result = handler ? await handler(command, clientId) : scoped ? scopedChat(options.hub, command, scoped) : options.hub.execute(command);
      if (!handler && result.ok && command && typeof command === 'object' && 'type' in command
        && command.type === 'watch' && 'sessionId' in command && typeof command.sessionId === 'string') {
        if (!session!.watched.has(clientId) && session!.watched.size >= 32) session!.watched.delete(session!.watched.keys().next().value!);
        session!.watched.set(clientId, command.sessionId);
      }
      return json(res, 200, result);
    }
    if (req.method !== 'GET') return failure(res, 405, '不支持此请求方法。');
    if (url.pathname === '/web-bridge.js') {
      res.setHeader('Content-Type', 'text/javascript; charset=utf-8'); res.end(browserBridgeSource + '\n' + (options.extraScript ?? '')); return;
    }
    if (url.pathname === '/' || url.pathname === '/embedded') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(browserIndex(await readFile(resolve(root, 'index.html'), 'utf8'))); return;
    }
    const file = await realpath(resolve(root, '.' + decodeURIComponent(url.pathname)));
    if (!file.startsWith(root + sep) || !types[extname(file)]) return failure(res, 404, '文件不存在。');
    res.setHeader('Content-Type', types[extname(file)]!); res.end(await readFile(file));
  }
  try {
    await new Promise<void>((accept, reject) => { server.once('error', reject); server.listen(options.port ?? 0, '127.0.0.1', () => { server.off('error', reject); accept(); }); });
  } catch (error) { clearInterval(heartbeat); unsubscribe(); throw error; }
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Web host did not bind.');
  origin = `http://127.0.0.1:${address.port}`;
  return { url: origin, issueHandoff: (sessionId: string) => {
    const { ticket, expiresAt } = handoffs.issue(sessionId);
    return { url: origin + '/embedded#' + ticket, expiresAt };
  }, revokeSession: (sessionId: string) => handoffs.revoke(sessionId), issuePairingCode: () => auth.issuePairingCode(), revokeAll: () => {
    auth.revokeAll(); handoffs.revoke(); for (const stream of streams) { stream.response.write('event: auth\ndata: {}\n\n'); stream.response.end(); }
  }, close: async () => {
    closing = true; clearInterval(heartbeat); unsubscribe(); auth.revokeAll(); handoffs.revoke(); for (const stream of streams) stream.response.end();
    await new Promise<void>(accept => { server.close(() => accept()); server.closeAllConnections(); });
  } };
}
