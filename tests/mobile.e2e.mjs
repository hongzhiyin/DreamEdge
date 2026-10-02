import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { webkit, devices } from 'playwright';
import { preview } from 'vite';
const server = await preview({ configFile: false, root: resolve('mobile'), build: { outDir: resolve('dist/mobile') }, preview: { host: '127.0.0.1', port: 0 } });
const browser = await webkit.launch();
const context = await browser.newContext({ ...devices['iPhone 13'] });
const page = await context.newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
try {
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`);
  await page.getByText('HelloWorld', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button').count(), 0);
  for (const size of [{ width: 375, height: 812 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(size);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  }
  await page.reload();
  await page.getByText('HelloWorld', { exact: true }).waitFor();
  await page.setViewportSize({ width: 375, height: 812 });
  await mkdir('artifacts/mobile', { recursive: true });
  await page.screenshot({ caret: 'initial', path: 'artifacts/mobile/hello-world.png' });
  assert.deepEqual(errors, []);
  console.log('PASS: mobile framework starts and reloads without business UI or premature AI controls.');
} finally {
  await context.close(); await browser.close();
  await new Promise(resolve => server.httpServer.close(resolve));
}
