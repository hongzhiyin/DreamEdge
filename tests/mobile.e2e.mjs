import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { webkit, devices } from 'playwright';
import { preview } from 'vite';

const profile = await mkdtemp(join(tmpdir(), 'dreamedge-mobile-'));
const server = await preview({ configFile: false, root: resolve('mobile'),
  build: { outDir: resolve('dist/mobile') }, preview: { host: '127.0.0.1', port: 0 } });
const address = server.httpServer.address();
const url = `http://127.0.0.1:${address.port}`;
const errors = [];
let context;
async function launch() {
  context = await webkit.launchPersistentContext(profile, { ...devices['iPhone 13'], headless: true });
  const page = context.pages()[0];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(url);
  await page.locator('button[type="submit"]:enabled').waitFor();
  return page;
}
async function noOverflow(page) {
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), '手机布局不应横向溢出');
}
async function screenshot(page, options) {
  const before = errors.length;
  await page.screenshot({ caret: 'initial', ...options });
  // WebKit's screenshot synchronization injects a harmless `body {}` style.
  // Keep the app's CSP enabled and recognize this instrumentation only here.
  for (const message of errors.splice(before)) {
    assert.equal(message, "Refused to apply a stylesheet because its hash, its nonce, or 'unsafe-inline' does not appear in the style-src directive of the Content Security Policy.");
  }
}
try {
  let page = await launch();
  await page.getByText('你的第一条阅读足迹').waitFor();
  await page.getByLabel('阅读内容').fill('手机阅读：可跨平台复用的界面');
  await page.getByLabel('阅读时长').fill('35');
  await page.getByRole('button', { name: '保存记录' }).click();
  await page.getByText('记录已保存到本机。').waitFor();
  await page.reload();
  await page.locator('.entry').waitFor();
  assert.equal(await page.locator('.entry-content p').innerText(), '手机阅读：可跨平台复用的界面');
  await mkdir('artifacts/mobile', { recursive: true });
  for (const [name, size] of [
    ['small-phone', { width: 375, height: 812 }],
    ['large-phone', { width: 430, height: 932 }],
    ['landscape', { width: 844, height: 390 }],
  ]) {
    await page.setViewportSize(size);
    await noOverflow(page);
    await screenshot(page, { path: `artifacts/mobile/${name}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 375, height: 812 });
  await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'dark' });
  await page.evaluate(() => { document.documentElement.style.fontSize = '24px'; });
  await noOverflow(page);
  assert.equal(await page.locator('html').evaluate(element => getComputedStyle(element).colorScheme), 'light');
  await screenshot(page, { path: 'artifacts/mobile/large-text.png', fullPage: true });
  await page.getByRole('button', { name: '打开 AI 助手' }).click();
  await page.getByRole('dialog', { name: 'AI 助手' }).waitFor();
  assert.ok(await page.getByLabel('AI 需求输入').isDisabled());
  await screenshot(page, { path: 'artifacts/mobile/assistant.png' });
  await page.getByRole('button', { name: '关闭 AI 面板' }).click();
  await context.close();
  page = await launch();
  await page.locator('.entry').waitFor();
  assert.equal(await page.locator('.entry').count(), 1);
  await page.getByRole('button', { name: /^删除记录/ }).click();
  await page.getByRole('button', { name: '确认删除' }).click();
  await page.getByText('你的第一条阅读足迹').waitFor();
  await page.reload();
  await page.getByText('你的第一条阅读足迹').waitFor();
  assert.deepEqual(errors, []);
  console.log('PASS: mobile WebKit add, reload, browser restart, deletion, phone layouts, large text and assistant.');
} catch (error) {
  const page = context?.pages()[0];
  if (page) {
    await mkdir('artifacts/mobile', { recursive: true });
    await page.screenshot({ caret: 'initial', path: 'artifacts/mobile/failure.png', fullPage: true }).catch(() => {});
    console.error(await page.locator('body').innerText().catch(() => 'unavailable'));
  }
  console.error('Renderer errors:', errors);
  throw error;
} finally {
  await context?.close().catch(() => {});
  await new Promise(resolve => server.httpServer.close(resolve));
  await rm(profile, { recursive: true, force: true });
}
