import { _electron as electron } from 'playwright';
import type { ElectronApplication, Page } from 'playwright';
import { mkdtemp, realpath, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { ChatView, ChatAttempt } from '../src/chat/types.js';

export interface FileLiveRequest { high: boolean; tools: string[]; reasoningReplayed: boolean; status?: number }
export const latestAttempt = (view: ChatView): ChatAttempt => view.messages.at(-1)!.attempts.at(-1)!;
export const fileCalls = (view: ChatView) => latestAttempt(view).timeline?.flatMap(item => item.kind === 'tool' ? [item.call] : []) ?? [];

/** Drives the production executable with an isolated profile and user-owned test data. */
export class FileLiveHost {
  app!: ElectronApplication; page!: Page;
  readonly errors: string[] = []; readonly requests: FileLiveRequest[] = [];
  constructor(readonly directory: string, readonly root: string,
    private readonly executable: string, private readonly config: string, private readonly credentials: string) {}
  static async create(executable: string, config: string, credentials: string) {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'dreamedge-file-live-')));
    const root = join(directory, 'files'); await mkdir(root); await mkdir(join(directory, 'profile'));
    await writeFile(join(root, 'note.txt'), 'sample-id: ORCHID-7319\nstatus: draft\n');
    await writeFile(join(root, '.env'), 'excluded-fixture-only\n');
    return new FileLiveHost(directory, root, executable, config, credentials);
  }
  async launch() {
    const env = Object.fromEntries(Object.entries(process.env).filter((item): item is [string, string] => typeof item[1] === 'string'));
    Object.assign(env, { DREAMEDGE_CONFIG_FILE: resolve(this.config), DREAMEDGE_CREDENTIALS_FILE: resolve(this.credentials),
      DREAMEDGE_DATA_DIR: join(this.directory, 'profile'), DREAMEDGE_NO_DIALOGS: '1' }); delete env.ELECTRON_RUN_AS_NODE;
    this.app = await electron.launch({ executablePath: resolve(this.executable), args: [], env, timeout: 20_000 });
    this.page = await this.app.firstWindow(); this.page.setDefaultTimeout(15_000);
    this.page.on('pageerror', () => this.errors.push('renderer-error'));
    await this.page.getByLabel('消息', { exact: true }).waitFor();
    await this.app.evaluate((_electron, root) => {
      const state = globalThis as unknown as { fileProbe: FileLiveRequest[] }; state.fileProbe = [];
      const original = globalThis.fetch;
      globalThis.fetch = async (input, init) => {
        let item: FileLiveRequest | undefined;
        if (typeof init?.body === 'string') {
          const body = JSON.parse(init.body);
          item = { high: body.reasoning_effort === 'high' && body.thinking?.type === 'enabled',
            tools: (body.tools ?? []).map((tool: { function: { name: string } }) => tool.function.name),
            reasoningReplayed: (body.messages ?? []).some((message: { reasoning_content?: string; tool_calls?: unknown[] }) =>
              Boolean(message.reasoning_content?.length && message.tool_calls?.length)) };
          state.fileProbe.push(item);
        }
        const response = await original(input, init); if (item) item.status = response.status; return response;
      };
      _electron.dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [root] })) as typeof _electron.dialog.showOpenDialog;
    }, this.root);
  }
  currentRequests() { return this.app.evaluate(() => (globalThis as unknown as { fileProbe: FileLiveRequest[] }).fileProbe); }
  async view() {
    return this.page.evaluate(async () => {
      const reply = await window.dreamedge.watch(sessionStorage.getItem('dreamedge:selected')!);
      if (reply.kind !== 'snapshot') throw new Error('Expected file chat snapshot'); return reply.event.view;
    });
  }
  async wait(condition: (view: ChatView) => boolean, timeoutMs = 120_000) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) { const view = await this.view(); if (condition(view)) return view; await delay(60); }
    throw new Error('File acceptance state timeout');
  }
  settled() { return this.wait(view => !view.activeRunId && latestAttempt(view).status !== 'running' && view.saving.status !== 'pending'); }
  approval(filename: string) { return this.wait(view => fileCalls(view).some(call => call.status === 'awaiting_approval' && call.preview?.path.endsWith(`/${filename}`))); }
  async send(text: string) {
    const count = await this.page.getByTestId('user-message').count();
    await this.page.getByLabel('消息', { exact: true }).fill(text);
    await this.page.getByRole('button', { name: '发送消息', exact: true }).click();
    await this.page.waitForFunction(count => document.querySelectorAll('[data-testid="user-message"]').length > count, count);
  }
  card(filename: string) { return this.page.getByTestId('tool-card').filter({ hasText: `/${filename}` }).last(); }
  async choose(mode: 'read' | 'read-write', remember = true) {
    const before = (await this.view()).fileScope!.policyVersion;
    await this.page.getByRole('button', { name: /^文件范围/ }).click();
    await this.page.getByLabel('目录权限').selectOption(mode); await this.page.getByLabel('重启后保留此授权').setChecked(remember);
    await this.page.getByRole('button', { name: '选择目录', exact: true }).click();
    await this.wait(view => view.fileScope!.policyVersion > before && view.saving.status === 'saved', 5000);
    await this.page.getByRole('button', { name: '关闭文件范围' }).click();
  }
  async revoke() {
    const before = (await this.view()).fileScope!.policyVersion;
    await this.page.getByRole('button', { name: /^文件范围/ }).click();
    await this.page.locator('.scope-grant[data-status="授权中"]').getByRole('button', { name: '撤销授权' }).click();
    await this.wait(view => view.fileScope!.policyVersion > before && view.saving.status === 'saved', 5000);
    await this.page.getByRole('button', { name: '关闭文件范围' }).click();
  }
  async close() {
    if (!this.app) return;
    this.requests.push(...await this.currentRequests().catch(() => []));
    const process = this.app.process();
    await Promise.race([this.app.close().catch(() => {}), delay(5000)]);
    if (process.exitCode === null && process.signalCode === null) process.kill('SIGKILL');
  }
  async dispose() {
    const view = await this.view().catch(() => undefined);
    if (view?.activeRunId) await this.page.evaluate(({ sessionId, runId }) => window.dreamedge.stop(sessionId, runId),
      { sessionId: view.sessionId, runId: view.activeRunId }).catch(() => {});
    await this.close(); await rm(this.directory, { recursive: true, force: true });
  }
}
