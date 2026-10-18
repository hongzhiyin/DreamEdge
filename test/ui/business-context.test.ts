import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { chromium, _electron as electron } from 'playwright';
import { callControl, controlDirectory } from '../../src/launch/socket.js';
import { modelDestination } from '../../src/model/destination.js';
import { connection, modelServer, chatReply } from '../helpers/server.js';
import { toolReply } from '../helpers/tool-loop.js';
import { send, completed } from './fixture.js';
import { launchProtocol } from '../../src/launch/protocol.js';

test('reader button hands off its actual window; Pi reads PDF through scoped MCP, persists and reconnects', { timeout: 90000 }, async t => {
  const readerRoot = process.env.RECOLLECTION_GARDEN_ROOT;
  if (!readerRoot) { t.skip('Set RECOLLECTION_GARDEN_ROOT for cross-application acceptance'); return; }
  await access(join(readerRoot, 'dist/index.html'));
  const dir = await mkdtemp(join(tmpdir(), 'business-context-')), profile = join(dir, 'ai'); await mkdir(profile);
  const bridgeFile = join(dir, 'bridge.json'), oldConfig = process.env.RG_BRIDGE_CONFIG;
  process.env.RG_BRIDGE_CONFIG = bridgeFile;
  const { startDesktop } = await import(pathToFileURL(join(readerRoot, 'desktop/runtime/server.mjs')).href);
  const reader = await startDesktop({ staticDir: join(readerRoot, 'dist'), uiPort: 0, bridgePort: 0 });
  if (oldConfig === undefined) delete process.env.RG_BRIDGE_CONFIG; else process.env.RG_BRIDGE_CONFIG = oldConfig;
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const provider = await modelServer((response, captured) => {
    const messages = captured.body.messages as { role: string; content: string }[];
    const lastUser = messages.map(m => m.role).lastIndexOf('user');
    const results = messages.slice(lastUser + 1).filter(m => m.role === 'tool');
    const tools = captured.body.tools as { function: { name: string; parameters: { properties: Record<string, unknown> } } }[];
    assert.equal(tools.length, 5);
    const read = tools.find(t => t.function.parameters.properties.page && !t.function.parameters.properties.zoom)!,
      navigate = tools.find(t => t.function.parameters.properties.zoom)!, context = tools.find(t => Object.keys(t.function.parameters.properties).length === 0)!,
      outline = tools.find(t => t.function.parameters.properties.query)!, outlineNavigate = tools.find(t => t.function.parameters.properties.target)!;
    if (!results.length) toolReply(response, [{ id: 'ctx-' + lastUser, name: context.function.name, args: {} }]);
    else if (results.length === 1) {
      const value = JSON.parse(results[0]!.content);
      if (!value.ok) return chatReply(response);
      const question = messages[lastUser]!.content;
      const selection = question.includes('第 5 章') ? { target: 'chapter', chapter: 5 } : question.includes('翻到目录') ? { target: 'contents' } : question.includes('Introduction') ? { target: 'title', title: 'Introduction' } : undefined;
      if (selection) return toolReply(response, [{ id: 'outline-' + lastUser, name: outlineNavigate.function.name, args: { ...selection, contextVersion: value.data.contextVersion } }]);
      if (question.includes('读取目录')) return toolReply(response, [{ id: 'outline-' + lastUser, name: outline.function.name, args: { contextVersion: value.data.contextVersion } }]);
      const navigation = question.includes('翻到下一页');
      toolReply(response, [{ id: 'page-' + lastUser, name: navigation ? navigate.function.name : read.function.name,
        args: { page: value.data.page + (navigation ? 1 : 0), contextVersion: value.data.contextVersion } }]);
    } else chatReply(response);
  });
  const config = connection(provider.baseUrl, { credentialRef: 'file:fixture', thinkingLevel: 'high',
    toolCalling: { supported: true, supportedThinkingLevels: ['high', 'off'] } });
  await writeFile(join(dir, 'config.json'), JSON.stringify(config)); await writeFile(join(dir, 'keys.json'), JSON.stringify({ fixture: 'test-only' }));
  const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => typeof e[1] === 'string')),
    DREAMEDGE_DATA_DIR: profile, DREAMEDGE_CONFIG_FILE: join(dir, 'config.json'), DREAMEDGE_CREDENTIALS_FILE: join(dir, 'keys.json'), DREAMEDGE_WEB_PORT: '0' };
  delete env.ELECTRON_RUN_AS_NODE;
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  t.after(async () => { await app?.close().catch(() => {}); await browser.close(); await provider.close(); await reader.close(); await rm(dir, { recursive: true, force: true }); });
  const launch = async (allow: boolean) => {
    const executablePath = process.env.DREAMEDGE_PACKAGE_EXECUTABLE;
    app = await electron.launch({ args: [...(executablePath ? [] : ['.']), '--background'], env, ...(executablePath ? { executablePath } : {}) });
    await app.evaluate(({ dialog }, allow) => {
      dialog.showMessageBox = (async () => ({ response: allow ? 0 : 1, checkboxChecked: false })) as typeof dialog.showMessageBox;
    }, allow);
    for (let i = 0; i < 100; i++) {
      try { await callControl(controlDirectory(profile), { protocol: launchProtocol, operation: 'status' }); break; }
      catch (error) { if (i === 99) throw error; await delay(50); }
    }
  };
  await launch(false); // Local user policy must avoid the native confirmation.
  const page = await browser.newPage();
  await page.addInitScript(() => {
    (window as any).handoff = null;
    (window as any).webkit = { messageHandlers: { gardenDesktop: { postMessage: (message: any) => {
      if (message.type === 'external.toggle') (window as any).handoff = message.context;
    } } } };
  });
  await page.goto(`http://127.0.0.1:${reader.uiPort}`);
  await page.getByTestId('pdf-input').setInputFiles({ name: 'scoped-acceptance.pdf', mimeType: 'application/pdf', buffer: await readFile(join(readerRoot, 'tests/fixtures/outline-navigation.pdf')) });
  await page.getByRole('button', { name: '阅读 scoped-acceptance', exact: true }).click();
  await page.locator('.textLayer').getByText('Selecting original text', { exact: false }).first().waitFor();
  await page.getByRole('button', { name: '外部对话', exact: true }).click();
  await page.waitForFunction(() => !!(window as any).handoff);
  const context = await page.evaluate(() => (window as any).handoff) as { window: string; resource: string; revision: string };
  const runner = join(dir, 'scoped-mcp.mjs');
  await writeFile(runner, `process.env.RG_BRIDGE_CONFIG=${JSON.stringify(bridgeFile)};await import(${JSON.stringify(pathToFileURL(join(readerRoot, 'bridge/mcp.mjs')).href)});`);
  const request = { protocol: launchProtocol, operation: 'open-session', requestId: 'first', application: { id: 'reader.acceptance', name: 'Reader test', profile: 'isolated' },
    context: { window: context.window, resource: context.resource }, mcp: { scope: 'Current PDF window, read only', readTools: ['rg_context_get', 'rg_page_read', 'rg_outline_get'], interactionTools: ['rg_reader_navigate', 'rg_outline_navigate'],
      transport: { type: 'stdio', command: process.execPath, args: [runner, '--window', context.window, '--book', context.resource] } } };
  await writeFile(join(profile, 'application-policies.json'), JSON.stringify({ format: 'ai-application-policies/v1', applications: [{
    applicationId: request.application.id, profile: request.application.profile, destination: modelDestination(config),
    command: process.execPath, args: [runner, '--window', { context: 'window' }, '--book', { context: 'resource' }],
    readTools: request.mcp.readTools, interactionTools: request.mcp.interactionTools,
  }] }));
  const opened = await callControl(controlDirectory(profile), request) as any; assert.equal(opened.ok, true, JSON.stringify(opened));
  assert.equal(opened.data.contextStatus, 'mcp-ready');
  const chat = await browser.newPage(); chat.setDefaultTimeout(15000); await chat.goto(opened.data.url);
  await chat.getByText('应用会话 · 已授权读取绑定窗口的内容', { exact: true }).waitFor();
  await send(chat, '当前页写了什么？'); await completed(chat, 'Hello world');
  assert.ok(JSON.stringify(provider.requests).includes('Selecting original text'));
  assert.equal(await chat.getByRole('button', { name: '允许这一次', exact: true }).count(), 0);
  const before = provider.requests.length;
  await app!.close(); await launch(false); // Remembered grants must not ask again.
  const resumed = await callControl(controlDirectory(profile), { ...request, requestId: 'again' }) as any;
  assert.equal(resumed.ok, true, JSON.stringify(resumed)); assert.equal(resumed.data.sessionId, opened.data.sessionId);
  await chat.goto(resumed.data.url); await completed(chat, 'Hello world'); assert.equal(provider.requests.length, before);
  await page.getByRole('button', { name: '下一页', exact: true }).click();
  await page.getByTestId('page-indicator').filter({ hasText: '第 2 / 3 页' }).waitFor();
  await send(chat, '再看一下当前页');
  await chat.getByText('Hello world', { exact: true }).nth(1).waitFor();
  const newRequests = provider.requests.slice(before);
  assert.match(JSON.stringify(newRequests), /\\"page\\":2/);
  await send(chat, '翻到下一页');
  await chat.getByText('Hello world', { exact: true }).nth(2).waitFor();
  await page.getByTestId('page-indicator').filter({ hasText: '第 3 / 3 页' }).waitFor();
  assert.equal(await chat.getByRole('button', { name: '允许这一次', exact: true }).count(), 0);
  const navigation: any = await chat.evaluate(async id => {
    const result = await window.dreamedge.watch(id);
    return result.kind === 'snapshot' ? result.event.view.messages.at(-1)?.attempts.at(-1)?.timeline?.find(item => item.kind === 'tool' && item.call.origin?.toolName === 'rg_reader_navigate') : undefined;
  }, opened.data.sessionId);
  assert.equal(navigation.call.effect, 'write'); assert.equal(navigation.call.status, 'succeeded');
  assert.equal(navigation.call.approval.inspection.decision, 'allow');
  await send(chat, '读取目录'); await chat.getByText('Hello world', { exact: true }).nth(3).waitFor();
  assert.ok(JSON.stringify(provider.requests).includes('Chapter 5: Services'));
  for (const [question, pageNumber, count] of [['翻到目录', 1, 4], ['打开第 5 章', 3, 5], ['打开 Introduction', 2, 6]] as const) {
    await send(chat, question); await chat.getByText('Hello world', { exact: true }).nth(count).waitFor();
    await page.getByTestId('page-indicator').filter({ hasText: `第 ${pageNumber} / 3 页` }).waitFor();
    assert.equal(await chat.getByRole('button', { name: '允许这一次', exact: true }).count(), 0);
  }
  await callControl(controlDirectory(profile), { protocol: launchProtocol, operation: 'revoke', application: request.application });
  const denied = await callControl(controlDirectory(profile), { ...request, requestId: 'denied' }) as any; assert.equal(denied.ok, false);
});
