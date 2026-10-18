import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ServerResponse } from 'node:http';
import type { TestContext } from 'node:test';
import { _electron as electron } from 'playwright';
import type { ElectronApplication, Page } from 'playwright';
import type { ChildProcess } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { beginSse, chatChunk, connection, modelServer, sse } from '../helpers/server.js';
import type { Handler } from '../helpers/server.js';

export async function uiFixture(t: TestContext, options: { timeoutMs?: number; handler?: Handler; tools?: boolean; entry?: string } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'dreamedge-ui-'));
  const profile = join(directory, 'profile');
  await mkdir(profile);
  const counts = new Map<string, number>();
  let stream: ServerResponse | undefined;
  const server = await modelServer(options.handler ?? ((response, request) => {
    const messages = request.body.messages as { role: string; content: string }[];
    const question = messages.at(-1)!.content;
    const count = (counts.get(question) ?? 0) + 1; counts.set(question, count);
    if (question === '触发重试' && count === 1) {
      response.writeHead(500, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'fixture-key provider unavailable' } })); return;
    }
    beginSse(response); chatChunk(response, { role: 'assistant' });
    chatChunk(response, { reasoning_content: '正在整理这个问题。' });
    if (question === '网络中断' && count === 1) {
      chatChunk(response, { content: '中断前片段。' }); setTimeout(() => response.destroy(), 200); return;
    }
    if (question === '协议不完整' || question === '长度上限') {
      chatChunk(response, { content: '不完整片段。' });
      if (question === '长度上限') { chatChunk(response, {}, 'length'); response.end('data: [DONE]\n\n'); }
      else response.end();
      return;
    }
    if (question === '请求超时') { chatChunk(response, { content: '超时前片段。' }); return; }
    if (question === '连续输出' || (question === '停止这次回复' && count === 1)) {
      stream = response; chatChunk(response, { content: '开头。\n\n' }); return;
    }
    const text = question === '长历史'
      ? Array.from({ length: 80 }, (_, i) => `第 ${i + 1} 段：阅读历史时，新的回复不会打断当前位置。`).join('\n\n')
      : question === '查暗号' ? (messages.some(message => message.content.includes('记住暗号：琥珀')) ? '暗号是琥珀。' : '这个会话没有暗号。')
      : question === '触发重试' ? '重试完成。' : question === '停止这次回复' ? '停止后的重试完成。'
      : question === '整理一个想法' ? '可以从这三个问题开始：\n\n1. **想解决什么问题？**\n2. 当前有什么可用的条件？\n3. 下一步最小的行动是什么？\n\n把其中一个展开，就能继续往前走。'
      : `收到：${question}`;
    chatChunk(response, { content: text }); chatChunk(response, {}, 'stop');
    sse(response, { choices: [], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } });
    response.end('data: [DONE]\n\n');
  }));
  const configPath = join(directory, 'connection.json');
  const credentialsPath = join(directory, 'credentials.json');
  await writeFile(configPath, JSON.stringify(connection(server.baseUrl, {
    model: 'deepseek-flash', credentialRef: 'file:fixture', thinkingLevel: 'high', timeoutMs: options.timeoutMs ?? 30_000,
    ...(options.tools ? { toolCalling: { supported: true, supportedThinkingLevels: ['high', 'low', 'off'] } } : {}),
  })));
  await writeFile(credentialsPath, JSON.stringify({ fixture: 'fixture-key' }), { mode: 0o600 });
  const apps = new Map<ElectronApplication, ChildProcess>();
  const errors: string[] = [];
  const launch = async () => {
    const env: Record<string, string> = Object.fromEntries(Object.entries(process.env)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
    Object.assign(env, { DREAMEDGE_CONFIG_FILE: configPath, DREAMEDGE_CREDENTIALS_FILE: credentialsPath,
      DREAMEDGE_DATA_DIR: profile, DREAMEDGE_NO_DIALOGS: '1' });
    delete env.ELECTRON_RUN_AS_NODE;
    const executablePath = options.entry ? undefined : process.env.DREAMEDGE_PACKAGE_EXECUTABLE;
    const app = await electron.launch({ args: executablePath ? [] : [options.entry ?? '.'], env, timeout: 20_000,
      ...(executablePath ? { executablePath } : {}) }); apps.set(app, app.process());
    app.once('close', () => { apps.delete(app); });
    const page = await app.firstWindow();
    page.on('pageerror', error => { errors.push(error.message); });
    await page.getByLabel('消息', { exact: true }).waitFor({ timeout: 15_000 });
    return { app, page };
  };
  t.after(async () => {
    for (const [app, process] of apps) {
      await Promise.race([app.close().catch(() => {}), delay(1500)]);
      if (process.exitCode === null && process.signalCode === null) process.kill('SIGKILL');
    }
    await server.close(); await rm(directory, { recursive: true, force: true });
  });
  return { launch, server, profile, errors,
    append: (text: string) => { if (stream && !stream.destroyed) chatChunk(stream, { content: text }); },
    finish: () => {
      if (stream && !stream.destroyed) { chatChunk(stream, {}, 'stop'); stream.end('data: [DONE]\n\n'); }
    } };
}
export type UiFixture = Awaited<ReturnType<typeof uiFixture>>;

export async function send(page: Page, text: string): Promise<void> {
  await page.getByLabel('消息', { exact: true }).fill(text);
  const previous = await page.getByTestId('user-message').filter({ hasText: text }).count();
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await page.waitForFunction(({ text, previous }) => [...document.querySelectorAll('[data-testid="user-message"]')]
    .filter(element => element.textContent?.includes(text)).length > previous, { text, previous });
}
export async function completed(page: Page, text: string, state: 'visible' | 'attached' = 'visible'): Promise<void> {
  await page.getByTestId('assistant-message').last().filter({ hasText: text })
    .and(page.locator('[data-status="completed"]')).waitFor({ timeout: 10_000, state });
}
