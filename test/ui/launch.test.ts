import test from 'node:test';
import assert from 'node:assert/strict';
import { _electron as electron, chromium } from 'playwright';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { modelServer, connection, chatReply } from '../helpers/server.js';
import { launchProtocol } from '../../src/launch/protocol.js';
import { LaunchStore } from '../../src/launch/store.js';
import { modelDestination } from '../../src/model/destination.js';
import { send, completed } from './fixture.js';

function cli(operation: string, value: unknown, env: NodeJS.ProcessEnv): Promise<any> {
  const executable = process.env.DREAMEDGE_LAUNCH_CLI ?? process.execPath;
  const args = [...(process.env.DREAMEDGE_LAUNCH_CLI ? [] : [resolve('dist/cli/main.js')]), operation];
  return new Promise((accept, reject) => {
    const child = spawn(executable, args, { env, stdio: ['pipe', 'pipe', 'pipe'] }); let out = '';
    child.stdout.on('data', chunk => { out += chunk; }); child.stderr.resume(); child.on('error', reject);
    child.on('exit', code => { try { const value = JSON.parse(out); if (code) reject(new Error(JSON.stringify(value))); else accept(value); } catch (error) { reject(error); } });
    child.stdin.end(value ? JSON.stringify(value) : '');
  });
}
async function setup(t: import('node:test').TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'launch-ui-')), profile = join(directory, 'profile'); await mkdir(profile);
  const requests: Record<string, unknown>[] = [];
  const model = await modelServer((res, request) => { requests.push(request.body); chatReply(res); });
  const config = connection(model.baseUrl, { credentialRef: 'file:fixture', toolCalling: { supported: true, supportedThinkingLevels: ['high', 'off'] } });
  const configFile = join(directory, 'model.json'), keyFile = join(directory, 'key.json');
  await writeFile(configFile, JSON.stringify(config)); await writeFile(keyFile, JSON.stringify({ fixture: 'test-only' }));
  const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => typeof e[1] === 'string')), DREAMEDGE_DATA_DIR: profile, DREAMEDGE_CONFIG_FILE: configFile,
    DREAMEDGE_CREDENTIALS_FILE: keyFile, DREAMEDGE_WEB_PORT: '0', DREAMEDGE_NO_DIALOGS: '1' }; delete env.ELECTRON_RUN_AS_NODE;
  t.after(async () => { await model.close(); await rm(directory, { recursive: true, force: true }); });
  const request = { protocol: launchProtocol, operation: 'open-session', requestId: 'request-1',
    application: { id: 'example.canvas', name: 'Canvas', profile: 'test' }, context: { window: 'first', resource: 'sheet' } };
  return { directory, profile, env, config, request, requests };
}
test('background has no window; CLI opens scoped chat, reuses trust, rejects cross-conversation and restores after restart', { timeout: 60000 }, async t => {
  const f = await setup(t);
  const executablePath = process.env.DREAMEDGE_PACKAGE_EXECUTABLE;
  const app = await electron.launch({ args: [...(executablePath ? [] : ['.']), '--background'], env: f.env,
    ...(executablePath ? { executablePath } : {}) });
  t.after(async () => { await app.close().catch(() => {}); });
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = (async () => ({ response: 0, checkboxChecked: false })) as typeof dialog.showMessageBox; });
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 0);
  const result = await cli('open-session', f.request, f.env); assert.equal(result.ok, true);
  assert.equal(result.data.contextStatus, 'reference-only');
  const repeated = await cli('open-session', f.request, f.env); assert.equal(repeated.data.sessionId, result.data.sessionId);
  const browser = await chromium.launch({ channel: 'chrome', headless: true }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(result.data.url); await page.getByLabel('消息', { exact: true }).waitFor();
  assert.equal(new URL(page.url()).hash, '');
  assert.equal(await page.getByRole('button', { name: 'MCP', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: '新对话', exact: true }).count(), 0);
  await send(page, '测试应用内文字对话'); await completed(page, 'Hello world');
  assert.equal(f.requests.length, 1); assert.equal(f.requests[0]!.tools, undefined);
  await page.reload(); await completed(page, 'Hello world'); assert.equal(f.requests.length, 1);
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 0);
  await app.close();
  const reopened = await cli('open-session', f.request, f.env);
  const state = await cli('status', null, f.env);
  t.after(() => { try { process.kill(state.data.pid, 'SIGTERM'); } catch {} });
  assert.equal(reopened.data.sessionId, result.data.sessionId); assert.equal(reopened.data.resumed, true);
  await page.goto(reopened.data.url); await completed(page, 'Hello world'); assert.equal(f.requests.length, 1);
  assert.deepEqual(errors, []);
});
test('CLI cold-starts one backend for simultaneous callers and status never starts it', { timeout: 45000 }, async t => {
  const f = await setup(t);
  assert.equal((await cli('status', null, f.env)).data.ready, false);
  const store = new LaunchStore(join(f.profile, 'launch.sqlite')); store.approve(f.request.application, JSON.stringify(modelDestination(f.config))); store.close();
  const [a, b] = await Promise.all([cli('open-session', f.request, f.env), cli('open-session', f.request, f.env)]);
  const status = await cli('status', null, f.env); t.after(() => { try { process.kill(status.data.pid, 'SIGTERM'); } catch {} });
  assert.equal(a.data.sessionId, b.data.sessionId); assert.equal(f.requests.length, 0);
});
