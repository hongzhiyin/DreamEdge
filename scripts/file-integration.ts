import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createCredentialResolver, parseModelConnection } from '../src/index.js';
import { FileLiveHost } from './file-live-host.js';
import { runFileLiveCases } from './file-live-cases.js';
import type { FileLiveCase } from './file-live-cases.js';

async function main() {
  const { values } = parseArgs({ options: {
    executable: { type: 'string', default: 'release/file-release-validation/DreamEdge-darwin-arm64/DreamEdge.app/Contents/MacOS/DreamEdge' },
    config: { type: 'string', default: 'config/deepseek.example.json' },
    credentials: { type: 'string', default: 'config/credentials.local.json' },
    report: { type: 'string' },
    'cancel-only': { type: 'boolean', default: false },
  } });
  const config = parseModelConnection(JSON.parse(await readFile(values.config, 'utf8')));
  if (config.thinkingLevel !== 'high' || !config.toolCalling?.supported) throw new Error('Live file config unsupported');
  const resolver = createCredentialResolver({ credentialsFile: values.credentials });
  if (!await resolver(config.credentialRef, new AbortController().signal)) throw new Error('Credentials missing');
  const startedAt = new Date().toISOString(); const cases: FileLiveCase[] = [];
  const reportPath = values.report ?? `docs/validation/file-${values['cancel-only'] ? 'cancel' : 'deepseek'}-2026-10-15.json`;
  const host = await FileLiveHost.create(values.executable, values.config, values.credentials);
  let environment: { packaged: boolean; electron: string; node: string } | undefined;
  try {
    await host.launch();
    environment = await host.app.evaluate(({ app }) => ({ packaged: app.isPackaged, electron: process.versions.electron!, node: process.versions.node }));
    if (!environment.packaged) throw new Error('A packaged application is required');
    await runFileLiveCases(host, cases, values['cancel-only']);
  } finally {
    await host.dispose();
    const report = { date: '2026-10-15', startedAt, finishedAt: new Date().toISOString(), environment,
      executable: resolve(values.executable), connection: { baseUrl: config.baseUrl, model: config.model, thinkingLevel: config.thinkingLevel },
      passed: cases.length === (values['cancel-only'] ? 1 : 10) && cases.every(item => item.passed), cases,
      realRequests: host.requests.length, requests: host.requests,
      scope: 'Production packaged executable, real DeepSeek API, isolated files and SQLite. Reports omit keys, prompts and response bodies. No human acceptance recorded.' };
    await mkdir(dirname(reportPath), { recursive: true }); await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    if (!report.passed) process.exitCode = 1;
  }
}
void main().catch(() => { process.stderr.write('文件真实联调未通过，请查看无密钥验证摘要。\n'); process.exitCode = 1; });
