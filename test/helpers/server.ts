import { createServer } from 'node:http';
import type { IncomingHttpHeaders, ServerResponse } from 'node:http';
import type { ModelConnectionConfig, RuntimeRequest } from '../../src/index.js';

export interface CapturedRequest {
  path: string;
  headers: IncomingHttpHeaders;
  body: Record<string, unknown>;
}
export type Handler = (response: ServerResponse, request: CapturedRequest) => void | Promise<void>;

export async function modelServer(handler: Handler) {
  const requests: CapturedRequest[] = [];
  const server = createServer(async (request, response) => {
    try {
      let data = '';
      for await (const chunk of request) data += String(chunk);
      const entry = { path: request.url ?? '', headers: request.headers,
        body: JSON.parse(data) as Record<string, unknown> };
      requests.push(entry);
      await handler(response, entry);
    } catch {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test address');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`, requests,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}

export function beginSse(response: ServerResponse): void {
  response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
}
export function sse(response: ServerResponse, data: unknown, event?: string): void {
  response.write(`${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(data)}\n\n`);
}
export function chatChunk(response: ServerResponse, delta: Record<string, unknown>, finish: string | null = null): void {
  sse(response, { id: 'completion-fixture', object: 'chat.completion.chunk',
    model: 'fixture-model', choices: [{ index: 0, delta, finish_reason: finish }] });
}
export function chatReply(response: ServerResponse, finish = 'stop'): void {
  beginSse(response);
  chatChunk(response, { role: 'assistant' });
  chatChunk(response, { reasoning_content: 'fixture reasoning' });
  chatChunk(response, { content: 'Hello' });
  chatChunk(response, { content: ' world' });
  chatChunk(response, {}, finish);
  sse(response, { choices: [], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } });
  response.end('data: [DONE]\n\n');
}

export function connection(baseUrl: string, overrides: Partial<ModelConnectionConfig> = {}): ModelConnectionConfig {
  return {
    id: 'fixture', protocol: 'openai-completions', baseUrl, model: 'fixture-model',
    contextWindow: 100000, maxOutputTokens: 8192, credentialRef: 'env:FIXTURE_KEY', timeoutMs: 5000,
    reasoning: { supportedLevels: ['off', 'low', 'high'], format: 'deepseek' }, ...overrides,
  };
}
export function request(): RuntimeRequest {
  return { sessionId: 'session-one', runId: 'run-one',
    messages: [{ role: 'system', content: 'Be concise.', timestamp: 1 },
      { role: 'user', content: 'Hello', timestamp: 2 }] };
}
export async function deadline<T>(operation: Promise<T>, ms = 3000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([operation, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Test deadline exceeded')), ms);
  })]); } finally { clearTimeout(timer); }
}
