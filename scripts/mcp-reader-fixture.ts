import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { readFile, mkdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { officialMcp } from './mcp-official.js';
export async function readerFixture(root: string, directory: string) {
  const profile = join(directory, 'reader-profile'); await mkdir(profile);
  const executable = join(root, 'releases/流光忆庭.app/Contents/MacOS/recollection-garden');
  const child = spawn(executable, ['serve'], { env: { ...process.env, RG_DESKTOP_DATA_DIR: profile,
    RG_DESKTOP_UI_PORT: '0', RG_DESKTOP_BRIDGE_PORT: '0', RG_DESKTOP_MANAGED: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.resume();
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const sdk = await officialMcp(root); const client = new sdk.Client({ name: 'independent-acceptance-client', version: '1' }, { capabilities: {} });
  const close = async () => { await client.close().catch(() => {}); await browser.close(); child.stdin.end();
    for (let i = 0; i < 30 && child.exitCode === null; i++) await delay(100);
    if (child.exitCode === null) child.kill('SIGKILL'); };
  try {
    let url: string | undefined;
    for (let i = 0; i < 150; i++) { url = /ready at (http:\/\/127\.0\.0\.1:\d+)/.exec(output)?.[1]; if (url) break;
      if (child.exitCode !== null) throw new Error('Provider startup failed'); await delay(100); }
    if (!url) throw new Error('Provider readiness timed out');
    const page = await browser.newPage(); await page.goto(url);
    await page.getByTestId('pdf-input').setInputFiles({ name: 'mcp-acceptance.pdf', mimeType: 'application/pdf',
      buffer: await readFile(join(root, 'tests/fixtures/text-navigation.pdf')) });
    await page.getByRole('button', { name: '阅读 mcp-acceptance', exact: true }).click();
    await page.locator('.textLayer').getByText('Selecting original text', { exact: false }).first().waitFor({ timeout: 15000 });
    await page.getByRole('button', { name: '关闭', exact: true }).click();
    await page.getByRole('button', { name: '连接本地服务', exact: true }).click();
    await page.getByText('外部工具已连接', { exact: true }).waitFor();
    await client.connect(new sdk.StdioClientTransport({ command: executable, args: ['mcp'], cwd: directory,
      stderr: 'pipe', env: { RG_DESKTOP_DATA_DIR: profile } }));
    const invoke = async (name: string, args = {}) => {
      const response = await client.callTool({ name, arguments: args });
      const value = JSON.parse(response.content.find((item: { type: string }) => item.type === 'text').text);
      if (!value.ok) throw new Error(`Independent provider ${name} failed: ${String(value.error?.code ?? 'unknown')}`); return value.data;
    };
    const sessions = await invoke('rg_sessions_list');
    if (sessions.length !== 1) throw new Error('Provider isolation failed');
    const session = sessions[0];
    const books = await invoke('rg_books_list', { sessionId: session.sessionId, params: {} });
    const book = books.find((b: { title: string }) => b.title === 'mcp-acceptance');
    await invoke('rg_reader_open', { sessionId: session.sessionId, bookId: book.id, params: {} });
    let input: Record<string, unknown> | undefined, result: unknown;
    for (let i = 0; i < 100; i++) {
      const live = (await invoke('rg_sessions_list'))[0];
      if (live.ready && live.bookId === book.id) {
        try {
          const context = await invoke('rg_context_get', { sessionId: live.sessionId, bookId: book.id, contextVersion: live.contextVersion, params: {} });
          input = { sessionId: live.sessionId, bookId: book.id, contextVersion: context.contextVersion, params: { page: 1 } };
          result = await invoke('rg_page_read', input); break;
        } catch (error) { if (!/NOT_READY|STALE_CONTEXT/.test(String(error))) throw error; }
      }
      await delay(100);
    }
    if (!input || !result) throw new Error('Provider page did not become ready');
    if (!JSON.stringify(result).includes('Selecting original text')) throw new Error('Independent read mismatch');
    const tools = await client.listTools();
    return { executable, profile, input, tools: tools.tools.length, independentRead: true, close };
  } catch (error) { await close(); throw error; }
}
