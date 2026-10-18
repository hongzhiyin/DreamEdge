import { _electron as electron } from 'playwright';
import type { ElectronApplication, Page } from 'playwright';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { ChatView } from '../src/chat/types.js';

async function main() {
  const profile = await mkdtemp(join(tmpdir(), 'dreamedge-packaged-live-'));
  const executablePath = resolve(`release/DreamEdge-${process.platform}-${process.arch}/DreamEdge.app/Contents/MacOS/DreamEdge`);
  const env = Object.fromEntries(Object.entries(process.env).filter((item): item is [string, string] => typeof item[1] === 'string'));
  Object.assign(env, { DREAMEDGE_CONFIG_FILE: resolve('config/deepseek.example.json'),
    DREAMEDGE_CREDENTIALS_FILE: resolve('config/credentials.local.json'), DREAMEDGE_DATA_DIR: profile, DREAMEDGE_NO_DIALOGS: '1' });
  delete env.ELECTRON_RUN_AS_NODE;
  let app: ElectronApplication | undefined; let page!: Page;
  const cases: { name: string; passed: boolean; checks: Record<string, boolean> }[] = [];
  const errors: string[] = []; const startedAt = new Date().toISOString();
  const launch = async () => {
    app = await electron.launch({ executablePath, args: [], env, timeout: 20_000 });
    page = await app.firstWindow(); page.on('pageerror', () => { errors.push('renderer-error'); });
    await page.getByLabel('消息', { exact: true }).waitFor();
    await app.evaluate(() => {
      const state = globalThis as unknown as { liveRequests: number };
      state.liveRequests = 0; const original = globalThis.fetch;
      globalThis.fetch = async (input, init) => { state.liveRequests++; return original(input, init); };
    });
  };
  const requests = () => app!.evaluate(() => (globalThis as unknown as { liveRequests: number }).liveRequests);
  const view = () => page.evaluate(async () => {
    const response = await window.dreamedge.watch(sessionStorage.getItem('dreamedge:selected')!);
    if (response.kind !== 'snapshot') throw new Error('Expected snapshot'); return response.event.view;
  });
  const send = async (text: string) => {
    await page.getByLabel('消息', { exact: true }).fill(text);
    const old = await page.getByTestId('user-message').count();
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await page.waitForFunction(count => document.querySelectorAll('[data-testid="user-message"]').length > count, old);
  };
  const waitForView = async (condition: (view: ChatView) => boolean): Promise<ChatView> => {
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      const current = await view(); if (condition(current)) return current; await delay(50);
    }
    throw new Error('Live view did not reach expected state');
  };
  const settled = () => waitForView(current => !current.activeRunId && ['completed', 'failed', 'cancelled'].includes(
    current.messages.at(-1)?.attempts.at(-1)?.status ?? ''));
  const record = (name: string, checks: Record<string, boolean>) => {
    const item = { name, checks, passed: Object.values(checks).every(Boolean) };
    cases.push(item); process.stdout.write(`${JSON.stringify(item)}\n`);
    if (!item.passed) throw new Error('Packaged live check failed');
  };
  let environment: { packaged: boolean; electron: string; node: string } | undefined;
  try {
    await launch();
    environment = await app!.evaluate(({ app }) => ({ packaged: app.isPackaged, electron: process.versions.electron!, node: process.versions.node }));
    process.stderr.write('开始打包应用真实工具链检查。\n');
    await send('必须先调用 get_current_time，拿到结果后再调用 add_numbers 计算 17+25。最后用一行返回时间与42，不要自行计算。');
    let current = await settled(); let attempt = current.messages.at(-1)!.attempts.at(-1)!;
    const cards = attempt.timeline?.filter(item => item.kind === 'tool') ?? [];
    record('packaged-tool-chain', { packaged: environment.packaged, completed: attempt.status === 'completed',
      highThinking: attempt.thinkingLevel === 'high', text42: attempt.text.includes('42'),
      timeExecuted: cards.some(item => item.kind === 'tool' && item.call.name === 'get_current_time' && item.call.status === 'succeeded'),
      additionExecuted: cards.some(item => item.kind === 'tool' && item.call.name === 'add_numbers' && item.call.status === 'succeeded'),
      saved: current.saving.status === 'saved', noRendererErrors: errors.length === 0 });
    await page.getByTestId('tool-card').last().getByText('参数与详情').click();
    await mkdir('docs/validation', { recursive: true });
    await page.screenshot({ path: 'docs/validation/tool-packaged-live-2026-10-14.png' });
    const before = await requests();
    await page.reload(); await page.getByTestId('tool-card').last().waitFor();
    record('packaged-renderer-recovery', { sameCardCount: await page.getByTestId('tool-card').count() === cards.length,
      noNewRequest: await requests() === before });
    await app!.close(); app = undefined; await launch(); await page.getByTestId('tool-card').last().waitFor();
    record('packaged-restart-recovery', { sameCardCount: await page.getByTestId('tool-card').count() === cards.length,
      noNewRequest: await requests() === 0 });
    await send('上一轮加法工具返回的结果是多少？不调用工具，只回复阿拉伯数字。');
    current = await settled(); attempt = current.messages.at(-1)!.attempts.at(-1)!;
    record('packaged-follow-up', { completed: attempt.status === 'completed', answer42: attempt.text.trim() === '42',
      noNewCalls: !attempt.timeline?.some(item => item.kind === 'tool'), saved: current.saving.status === 'saved' });
    process.stderr.write('开始打包应用真实取消检查。\n');
    await send('先调用 add_numbers 计算21+21。工具返回后，连续列出1000条简短书桌整理建议，不要省略。');
    await waitForView(current => {
      const attempt = current.messages.at(-1)?.attempts.at(-1);
      const tail = attempt?.timeline?.at(-1);
      return Boolean(attempt?.status === 'running' && tail?.kind === 'model' && tail.text.length > 0
        && attempt.timeline?.some(item => item.kind === 'tool' && item.call.status === 'succeeded'));
    });
    await page.getByRole('button', { name: '停止生成' }).click(); current = await settled();
    attempt = current.messages.at(-1)!.attempts.at(-1)!; const requestCount = await requests();
    await delay(500);
    record('packaged-cancel-after-result', { cancelled: attempt.status === 'cancelled', partialText: attempt.text.length > 0,
      retainedResult: attempt.timeline?.some(item => item.kind === 'tool' && item.call.status === 'succeeded') ?? false,
      noRequestsAfterStop: await requests() === requestCount, saved: current.saving.status === 'saved' });
  } finally {
    const report = { date: '2026-10-14', startedAt, finishedAt: new Date().toISOString(), environment,
      passed: cases.length === 5 && cases.every(item => item.passed), cases,
      scope: 'Production packaged executable and real DeepSeek; isolated profile; no keys or conversation bodies recorded.' };
    const path = 'docs/validation/tool-packaged-live-2026-10-14.json'; await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(report, null, 2)}\n`);
    await app?.close(); await rm(profile, { recursive: true, force: true }); if (!report.passed) process.exitCode = 1;
  }
}
void main().catch(() => { process.stderr.write('打包应用真实联调未通过，请查看无密钥验收摘要。\n'); process.exitCode = 1; });
