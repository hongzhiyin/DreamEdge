import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { createCredentialResolver, parseModelConnection } from '../src/index.js';
import { FileLiveHost, fileCalls, latestAttempt } from './file-live-host.js';
import { runOperationCases } from './operation-live-cases.js';
import type { FileLiveCase } from './file-live-cases.js';
async function main() {
  const { values } = parseArgs({ options: {
    executable: { type: 'string', default: 'release/file-policy-validation/DreamEdge-darwin-arm64/DreamEdge.app/Contents/MacOS/DreamEdge' },
    config: { type: 'string', default: 'config/deepseek.example.json' }, credentials: { type: 'string', default: 'config/credentials.local.json' },
    report: { type: 'string', default: 'docs/validation/file-policy-live-2026-10-17.json' },
  } });
  const config = parseModelConnection(JSON.parse(await readFile(values.config, 'utf8')));
  if (config.thinkingLevel !== 'high' || !config.toolCalling?.supported) throw new Error('Unsupported configuration');
  await createCredentialResolver({ credentialsFile: values.credentials })(config.credentialRef, new AbortController().signal);
  const host = await FileLiveHost.create(values.executable, values.config, values.credentials);
  const cases: FileLiveCase[] = []; const startedAt = new Date().toISOString(); let failure: unknown;
  let environment: unknown;
  try {
    await host.launch(); environment = await host.app.evaluate(({ app }) => ({ packaged: app.isPackaged, electron: process.versions.electron, node: process.versions.node }));
    await runOperationCases(host, cases);
  } catch {
    const view = await host.view().catch(() => undefined);
    failure = view ? { runStatus: latestAttempt(view).status, error: latestAttempt(view).error,
      tools: fileCalls(view).map(c => ({ name: c.name, status: c.status, error: c.error, batchStatuses: c.batchItems?.map(m => m.status) })) } : 'Application unavailable';
  } finally {
    await host.dispose();
    const passed = !failure && cases.length === 6 && cases.every(c => c.passed) && host.requests.every(r => r.high && r.status === 200);
    const report = { date: '2026-10-17', startedAt, finishedAt: new Date().toISOString(), passed, environment,
      executable: resolve(values.executable), connection: { baseUrl: config.baseUrl, model: config.model, thinkingLevel: config.thinkingLevel },
      cases, requests: host.requests, realRequests: host.requests.length, ...(failure ? { failure } : {}),
      scope: 'Production packaged app and real DeepSeek. Isolated profile and fixture directory; original Electron shell.trashItem, no replacement. Test-approved batch decisions only, no human acceptance. No daily profile changes.',
      trashCleanup: 'Only the generated fixture is moved to the system trash; the trash is not emptied.' };
    await mkdir(dirname(values.report), { recursive: true }); await writeFile(values.report, JSON.stringify(report, null, 2) + '\n');
    if (!passed) process.exitCode = 1;
  }
}
void main().catch(() => { process.stderr.write('新增文件操作联调未完成；请查看不含密钥的验收摘要。\n'); process.exitCode = 1; });
