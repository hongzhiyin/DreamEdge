import { outlineLiveCases } from './outline-live-cases.js';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { parseModelConnection } from '../src/model/config.js';
import { modelDestination } from '../src/model/destination.js';
import { LaunchStore } from '../src/launch/store.js';
import { launchTrustDestination } from '../src/launch/mcp-offer.js';
import { launchProtocol, type OpenSession } from '../src/launch/protocol.js';
import { callControl, controlDirectory } from '../src/launch/socket.js';

const root = process.env.RECOLLECTION_GARDEN_ROOT;
const outline = process.env.READING_OUTLINE_ACCEPTANCE === '1';
const navigation = outline || process.env.READING_NAVIGATION_ACCEPTANCE === '1';
const reportDate = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date());
const release = navigation ? 'reader-navigation' : 'business-context';
if (!root) throw new Error('RECOLLECTION_GARDEN_ROOT required');
const directory = await mkdtemp(join(tmpdir(), 'business-live-'));
const aiProfile = join(directory, 'ai'), readerProfile = join(directory, 'reader'); await mkdir(aiProfile); await mkdir(readerProfile);
const readerBundle = join(root, 'releases', outline ? 'reader-outline' : release, '流光忆庭.app');
const aiCli = resolve('release', release, 'DreamEdge-darwin-arm64/DreamEdge.app/Contents/MacOS/dreamedge-cli');
const config = parseModelConnection(JSON.parse(await readFile('config/deepseek.example.json', 'utf8')));
const configPath = join(directory, 'connection.json'); await writeFile(configPath, JSON.stringify(config));
const environment = { ...process.env, DREAMEDGE_DATA_DIR: aiProfile, DREAMEDGE_CONFIG_FILE: configPath,
  DREAMEDGE_CREDENTIALS_FILE: resolve('config/credentials.local.json'), DREAMEDGE_WEB_PORT: '0' };
const child = spawn(join(readerBundle, 'Contents/MacOS/recollection-garden'), ['serve'], { env: { ...process.env,
  RG_DESKTOP_DATA_DIR: readerProfile, RG_DESKTOP_UI_PORT: '0', RG_DESKTOP_BRIDGE_PORT: '0', RG_DESKTOP_MANAGED: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
let output = ''; child.stdout.on('data', bytes => { output += bytes; }); child.stderr.resume();
const browser = await chromium.launch({ channel: 'chrome', headless: true }); let aiPid: number | undefined;
try {
  let url: string | undefined;
  for (let i = 0; i < 100; i++) { url = /ready at (http:\/\/127\.0\.0\.1:\d+)/.exec(output)?.[1]; if (url) break; await delay(100); }
  if (!url) throw new Error('Reader startup timeout');
  const reader = await browser.newPage();
  await reader.addInitScript(() => { (window as any).handoff = null; (window as any).webkit = { messageHandlers: { gardenDesktop: {
    postMessage: (message: any) => { if (message.type === 'external.toggle') (window as any).handoff = message.context; } } } }; });
  await reader.goto(url);
  await reader.getByTestId('pdf-input').setInputFiles({ name: 'live-scope-test.pdf', mimeType: 'application/pdf', buffer: await readFile(join(root, 'tests/fixtures', outline ? 'outline-navigation.pdf' : 'text-navigation.pdf')) });
  await reader.getByRole('button', { name: '阅读 live-scope-test', exact: true }).click();
  await reader.locator('.textLayer').getByText('Selecting original text', { exact: false }).first().waitFor();
  await reader.getByRole('button', { name: '外部对话', exact: true }).click(); await reader.waitForFunction(() => !!(window as any).handoff);
  const context = await reader.evaluate(() => (window as any).handoff);
  const runner = join(directory, 'reader-mcp.mjs');
  await writeFile(runner, `process.env.RG_DESKTOP_DATA_DIR=${JSON.stringify(readerProfile)};await import(${JSON.stringify(pathToFileURL(join(readerBundle, 'Contents/Resources/app/desktop/runtime/entry.mjs')).href)});`);
  const request: OpenSession = { protocol: launchProtocol, operation: 'open-session', requestId: 'live-read',
    application: { id: 'acceptance.reader', name: 'Synthetic PDF acceptance', profile: 'isolated' },
    context: { window: context.window, resource: context.resource }, mcp: { scope: 'Synthetic test PDF only', readTools: ['rg_context_get', 'rg_page_read', ...(outline ? ['rg_outline_get'] : [])], ...(navigation ? { interactionTools: ['rg_reader_navigate', ...(outline ? ['rg_outline_navigate'] : [])] } : {}),
      transport: { type: 'stdio', command: process.execPath, args: [runner, 'mcp', '--window', context.window, '--book', context.resource] } } };
  if (navigation) {
    await writeFile(join(aiProfile, 'application-policies.json'), JSON.stringify({ format: 'ai-application-policies/v1', applications: [{
      applicationId: request.application.id, profile: request.application.profile, command: process.execPath,
      args: [runner, 'mcp', '--window', { context: 'window' }, '--book', { context: 'resource' }],
      readTools: request.mcp!.readTools, interactionTools: request.mcp!.interactionTools, destination: modelDestination(config),
    }] }));
  } else {
    const trust = new LaunchStore(join(aiProfile, 'launch.sqlite'));
    trust.approve(request.application, launchTrustDestination(JSON.stringify(modelDestination(config)), request.mcp)); trust.close();
  }
  const opened: any = await new Promise((accept, reject) => {
    const command = spawn(aiCli, ['open-session'], { env: environment, stdio: ['pipe', 'pipe', 'pipe'] }); let stdout = '';
    command.stdout.on('data', bytes => { stdout += bytes; }); command.stderr.resume(); command.on('error', reject);
    command.on('exit', code => { try { const result = JSON.parse(stdout); if (code || !result.ok) reject(new Error('AI startup rejected')); else accept(result.data); } catch (e) { reject(e); } });
    command.stdin.end(JSON.stringify(request));
  });
  const status: any = await callControl(controlDirectory(aiProfile), { protocol: launchProtocol, operation: 'status' }); aiPid = status.data.pid;
  const chat = await browser.newPage(); await chat.goto(opened.url); await chat.getByLabel('消息', { exact: true }).waitFor();
  if (outline) await outlineLiveCases(chat, reader, opened.sessionId, reportDate, config.model);
  else {
  await chat.getByLabel('消息', { exact: true }).fill(navigation ? '请先读取当前上下文，然后直接翻到下一页，确认新的物理页码。不需要问我确认，不要写笔记或修改文件。回答简短。' : '请通过已授权工具读取当前窗口和当前页，告诉我物理页码，并原样引用页面开头的一句英文。不要修改任何内容，回答简短。');
  await chat.getByRole('button', { name: '发送消息', exact: true }).click();
  let attempt: any;
  const deadline = Date.now() + 150000;
  while (Date.now() < deadline) {
    const state: any = await chat.evaluate(id => window.dreamedge.watch(id), opened.sessionId);
    attempt = state.event.view.messages.at(-1)?.attempts.at(-1);
    if (attempt && !['running', 'cancelling'].includes(attempt.status)) break;
    await delay(300);
  }
  await writeFile('docs/validation/business-context-live-attempt.json', JSON.stringify(attempt, null, 2) + '\n');
  if (attempt?.status !== 'completed') throw new Error('Live run did not complete: ' + String(attempt?.status));
  const calls = attempt.timeline.filter((item: any) => item.kind === 'tool').map((item: any) => item.call);
  const readPassed = !!calls.some((call: any) => call.origin?.toolName === 'rg_context_get' && call.status === 'succeeded')
    && calls.some((call: any) => call.origin?.toolName === 'rg_page_read' && call.status === 'succeeded')
    && calls.every((call: any) => call.effect === 'read')
    && calls.some((call: any) => JSON.stringify(call.result).includes('Selecting original text'))
    && ['Selecting original text', 'Across lines we keep the original source.'].some(text => attempt.text.includes(text));
  const navigated = await reader.getByTestId('page-indicator').textContent();
  const passed = navigation ? /2 \/ 3/.test(navigated ?? '') && calls.some((call: any) => call.origin?.toolName === 'rg_reader_navigate' && call.status === 'succeeded' && call.effect === 'write' && call.approval?.inspection?.decision === 'allow') : readPassed;
  const report = { date: reportDate, status: passed ? 'passed' : 'failed', model: config.model, thinking: config.thinkingLevel,
    packaged: true, testData: 'synthetic text-navigation.pdf only', navigation, pageIndicator: navigated, humanAcceptance: false,
    tools: calls.map((call: any) => ({ name: call.origin.toolName, status: call.status, effect: call.effect })), text: attempt.text };
  await writeFile(`docs/validation/${navigation ? 'reader-navigation' : 'business-context'}-live-${reportDate}.json`, JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(JSON.stringify({ status: report.status, tools: report.tools, model: report.model, ...(passed ? {} : { text: attempt.text }) }) + '\n');
  if (!passed) throw new Error('Live read did not match the synthetic PDF');
  }
} finally {
  if (aiPid) { try { process.kill(aiPid, 'SIGTERM'); } catch {} }
  await browser.close(); child.stdin.end();
  for (let i = 0; i < 30 && child.exitCode === null; i++) await delay(100);
  if (child.exitCode === null) child.kill('SIGKILL');
  await rm(directory, { recursive: true, force: true });
}
