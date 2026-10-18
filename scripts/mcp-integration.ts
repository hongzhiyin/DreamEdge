import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { createCredentialResolver, parseModelConnection } from '../src/index.js';
import { readerFixture } from './mcp-reader-fixture.js';
import { ledgerFixture } from './mcp-ledger-fixture.js';
import { McpLiveHost, attempt, calls } from './mcp-live-host.js';
import { mcpLiveCases } from './mcp-live-cases.js';
import type { McpLiveCase } from './mcp-live-cases.js';
async function main() {
  const { values } = parseArgs({ options: {
    executable: { type: 'string', default: 'release/mcp-validation/DreamEdge-darwin-arm64/DreamEdge.app/Contents/MacOS/DreamEdge' },
    'provider-root': { type: 'string' }, config: { type: 'string', default: 'config/deepseek.example.json' },
    credentials: { type: 'string', default: 'config/credentials.local.json' }, report: { type: 'string', default: 'docs/validation/mcp-live-2026-10-17.json' },
  } });
  if (!values['provider-root']) throw new Error('Provider path required');
  const config = parseModelConnection(JSON.parse(await readFile(values.config, 'utf8')));
  if (config.thinkingLevel !== 'high' || !config.toolCalling?.supported) throw new Error('Unexpected model config');
  if (!await createCredentialResolver({ credentialsFile: values.credentials })(config.credentialRef, new AbortController().signal)) throw new Error('Missing key');
  const directory = await mkdtemp(join(tmpdir(), 'dreamedge-mcp-live-')); await mkdir(join(directory, 'profile'));
  const startedAt = new Date().toISOString(), cases: McpLiveCase[] = [];
  let reader: Awaited<ReturnType<typeof readerFixture>> | undefined, ledger: Awaited<ReturnType<typeof ledgerFixture>> | undefined;
  let host: McpLiveHost | undefined, environment: unknown, failure: unknown;
  try {
    reader = await readerFixture(resolve(values['provider-root']), directory);
    ledger = await ledgerFixture(resolve(values['provider-root']), directory);
    host = new McpLiveHost(directory, values.executable, values.config, values.credentials, config.baseUrl, reader.profile);
    await host.launch(); environment = await host.app.evaluate(({ app }) => ({ packaged: app.isPackaged, electron: process.versions.electron, node: process.versions.node }));
    await mcpLiveCases(host, reader, ledger, cases);
  } catch {
    const view = await host?.view().catch(() => undefined);
    failure = view?.messages.length ? { run: attempt(view).status, error: attempt(view).error,
      calls: calls(view).map(c => ({ tool: c.origin?.toolName, status: c.status })) } : 'Fixture or application setup failed';
  } finally {
    if (host) { await host.stop().catch(() => {}); await host.close().catch(() => {}); }
    await ledger?.close(); await reader?.close(); await rm(directory, { recursive: true, force: true });
    const requests = host?.requests ?? [];
    const report = { date: '2026-10-17', startedAt, finishedAt: new Date().toISOString(),
      passed: !failure && cases.length === 9 && cases.every(c => c.passed) && requests.every(r => r.high && r.status === 200),
      executable: resolve(values.executable), environment, connection: { baseUrl: config.baseUrl, model: config.model, thinkingLevel: config.thinkingLevel },
      cases, realRequests: requests.length, requests, ...(failure ? { failure } : {}),
      scope: 'Production DreamEdge package; real DeepSeek; isolated real RecollectionGarden package/runtime and fixture PDF; independent official SDK client; separate disposable ledger app via official SDK HTTP. Test-approved decisions, not human acceptance. No keys, prompt/response bodies or daily profile data retained.' };
    await mkdir(dirname(values.report), { recursive: true }); await writeFile(values.report, JSON.stringify(report, null, 2) + '\n');
    if (!report.passed) process.exitCode = 1;
  }
}
void main().catch(() => { process.stderr.write('MCP 真实联调未完成，请查看无密钥验收摘要。\n'); process.exitCode = 1; });
