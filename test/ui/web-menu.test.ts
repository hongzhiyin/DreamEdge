import test from 'node:test';
import assert from 'node:assert/strict';
import { uiFixture } from './fixture.js';

test('desktop menu starts the packaged web host and closes its listener', { timeout: 20000 }, async t => {
  const previous = process.env.DREAMEDGE_WEB_PORT; process.env.DREAMEDGE_WEB_PORT = '0';
  t.after(() => { if (previous === undefined) delete process.env.DREAMEDGE_WEB_PORT; else process.env.DREAMEDGE_WEB_PORT = previous; });
  const f = await uiFixture(t), { app } = await f.launch();
  const detail = await app.evaluate(async ({ Menu, dialog }) => {
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Pairing dialog not reached')), 5000);
      dialog.showMessageBox = (async (_window: unknown, options: { detail?: string }) => {
        clearTimeout(timer); resolve(options.detail ?? ''); return { response: 1, checkboxChecked: false };
      }) as typeof dialog.showMessageBox;
      const menu = Menu.getApplicationMenu(); const item = menu?.getMenuItemById('web-enable');
      if (!item || !menu) throw new Error('Web menu missing');
      item.click(undefined, undefined, {} as never);
    });
  });
  const url = /地址：(http:\/\/127\.0\.0\.1:\d+)/.exec(detail)?.[1];
  assert.ok(url); assert.match(detail, /一次性配对码/);
  const response = await fetch(url); assert.equal(response.status, 200);
  assert.match(await response.text(), /一次性配对码/);
  await app.evaluate(({ Menu }) => { const item = Menu.getApplicationMenu()!.getMenuItemById('web-close')!;
    item.click(undefined, undefined, {} as never); });
  const end = Date.now() + 3000;
  while (true) {
    try { await fetch(url); } catch { break; }
    assert.ok(Date.now() < end, 'Web listener should close'); await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.deepEqual(f.errors, []);
});
