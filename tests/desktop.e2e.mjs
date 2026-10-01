import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { _electron as electron } from 'playwright';
import electronPath from 'electron';

const directory = await mkdtemp(join(tmpdir(), 'ideadock-e2e-'));
const errors = [];
let application;
async function launch() {
  const environment = { ...process.env, IDEADOCK_DATA_DIR: directory };
  delete environment.ELECTRON_RUN_AS_NODE;
  application = await electron.launch({
    executablePath: process.env.IDEADOCK_EXECUTABLE_PATH || electronPath,
    args: process.env.IDEADOCK_EXECUTABLE_PATH ? [] : [resolve('.')],
    env: environment,
  });
  await application.evaluate(({ app, BrowserWindow }) => {
    app.focus({ steal: true });
    BrowserWindow.getAllWindows()[0].focus();
  });
  const page = await application.firstWindow();
  await page.setViewportSize({ width: 920, height: 650 });
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  const tool = page.frameLocator('iframe');
  await tool.locator('button[type="submit"]:enabled').waitFor();
  return { page, tool };
}

try {
  let { page, tool } = await launch();
  await tool.getByText('你的第一条阅读足迹').waitFor();
  await tool.getByLabel('阅读日期').fill('2026-10-02');
  await tool.getByLabel('阅读内容').fill('《设计数据密集型应用》第一章\n可靠性与可维护性');
  await tool.getByLabel('阅读时长').fill('45');
  await tool.getByRole('button', { name: '保存记录' }).click();
  await tool.getByText('记录已保存到本机。').waitFor();
  assert.equal(await tool.locator('.entry').count(), 1);
  assert.equal(await tool.locator('.stats').innerText().then(text => text.includes('45')), true);

  // Whitespace content is rejected without a write, and the draft stays editable.
  await tool.getByLabel('阅读内容').fill('   ');
  await tool.getByRole('button', { name: '保存记录' }).click();
  await tool.getByRole('alert').getByText('写下这次阅读的内容。').waitFor();
  assert.equal(await tool.locator('.entry').count(), 1);
  await tool.getByLabel('阅读内容').fill('');

  await page.getByRole('button', { name: '重新加载工具' }).click();
  await tool.locator('.entry').waitFor();
  assert.equal(await tool.locator('.entry-content p').innerText(), '《设计数据密集型应用》第一章\n可靠性与可维护性');
  assert.equal(await tool.locator('.duration').innerText(), '45 分钟');
  assert.equal(await tool.locator('body').evaluate(() => typeof window.ideaDock), 'undefined');
  assert.equal(await tool.locator('body').evaluate(() => typeof window.require), 'undefined');
  const unknownTool = await page.evaluate(async () => {
    try { await window.ideaDock.storage('unknown', { operation: 'list', collection: 'entries' }); return false; }
    catch { return true; }
  });
  assert.ok(unknownTool);

  await mkdir('artifacts', { recursive: true });
  await page.screenshot({ path: 'artifacts/reading-log.png' });
  await page.getByRole('button', { name: 'AI 助手' }).click();
  await page.getByRole('complementary', { name: 'AI 助手' }).waitFor();
  assert.ok(await page.getByLabel('AI 需求输入').isDisabled());
  await page.screenshot({ path: 'artifacts/ai-panel.png' });
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('complementary', { name: 'AI 助手' }).count(), 0);
  await tool.getByLabel('阅读内容').focus();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k');
  await page.getByRole('complementary', { name: 'AI 助手' }).waitFor();
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 920, height: 650 });
  assert.ok(await tool.locator('body').evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: 'artifacts/compact.png' });

  await application.close();
  ({ page, tool } = await launch());
  await tool.locator('.entry').waitFor();
  assert.equal(await tool.locator('.entry').count(), 1);
  await tool.getByRole('button', { name: /^删除记录/ }).click();
  await tool.getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(await tool.locator('.entry').count(), 1);
  await tool.getByRole('button', { name: /^删除记录/ }).click();
  await tool.getByRole('button', { name: '确认删除' }).click();
  await tool.getByText('你的第一条阅读足迹').waitFor();
  await application.close();
  ({ page, tool } = await launch());
  await tool.getByText('你的第一条阅读足迹').waitFor();
  assert.equal(await tool.locator('.entry').count(), 0);
  assert.deepEqual(errors, []);
  console.log('PASS: add, validation, reload, isolation, AI entry, compact layout, restart persistence, confirmed deletion.');
} catch (error) {
  const page = application?.windows()[0];
  if (page) {
    await mkdir('artifacts', { recursive: true });
    await page.screenshot({ path: 'artifacts/failure.png' }).catch(() => {});
    for (const frame of page.frames()) {
      console.error('FRAME', frame.url(), await frame.locator('body').innerText().catch(() => 'unavailable'));
      console.error('FORM', await frame.locator('form').evaluateAll(forms => forms.map(form => ({
        valid: form.checkValidity(),
        fields: [...form.querySelectorAll('input,textarea')].map(field => ({ type: field.type, value: field.value, validity: field.validationMessage })),
      }))).catch(() => []));
    }
  }
  console.error('Renderer errors:', errors);
  throw error;
} finally {
  await application?.close().catch(() => {});
  await rm(directory, { recursive: true, force: true });
}
