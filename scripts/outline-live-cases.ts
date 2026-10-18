import type { Page } from 'playwright';
import { setTimeout as delay } from 'node:timers/promises';
import { writeFile } from 'node:fs/promises';

export async function outlineLiveCases(chat: Page, reader: Page, sessionId: string, date: string, model: string) {
  const cases = [
    { prompt: '请读取这本书的目录，然后打开第 5 章。操作完成后简短确认。', page: 3 },
    { prompt: '翻到目录。', page: 1 },
  ];
  const results: Record<string, unknown>[] = [];
  for (const scenario of cases) {
    const prior: any = await chat.evaluate(id => window.dreamedge.watch(id), sessionId);
    const count = prior.event.view.messages.length;
    await chat.getByLabel('消息', { exact: true }).fill(scenario.prompt);
    await chat.getByRole('button', { name: '发送消息', exact: true }).click();
    const deadline = Date.now() + 150000; let attempt: any;
    while (Date.now() < deadline) {
      const state: any = await chat.evaluate(id => window.dreamedge.watch(id), sessionId);
      if (state.event.view.messages.length > count) {
        attempt = state.event.view.messages.at(-1)?.attempts.at(-1);
        if (attempt && !['running', 'cancelling'].includes(attempt.status)) break;
      }
      await delay(300);
    }
    const calls = attempt?.timeline?.filter((item: any) => item.kind === 'tool').map((item: any) => item.call) ?? [];
    const page = await reader.getByTestId('page-indicator').textContent();
    const passed = attempt?.status === 'completed' && page?.includes(`第 ${scenario.page} / 3 页`)
      && calls.some((call: any) => call.origin?.toolName === 'rg_outline_navigate' && call.status === 'succeeded'
        && call.effect === 'write' && call.approval?.inspection?.decision === 'allow')
      && (results.length > 0 || calls.some((call: any) => call.origin?.toolName === 'rg_outline_get' && call.status === 'succeeded'));
    results.push({ prompt: scenario.prompt, expectedPage: scenario.page, page, passed, text: attempt?.text, error: attempt?.error,
      tools: calls.map((call: any) => ({ name: call.origin?.toolName, args: call.args, status: call.status, effect: call.effect })) });
    await writeFile(`docs/validation/reader-outline-live-${date}.json`, JSON.stringify({ date, model, thinking: 'high',
      fixture: 'synthetic outline-navigation.pdf', humanAcceptance: false, results }, null, 2) + '\n');
    process.stdout.write(JSON.stringify({ outlineCase: results.length, passed, page }) + '\n');
    if (!passed) throw new Error('Outline live acceptance failed; see scoped test report');
  }
}
