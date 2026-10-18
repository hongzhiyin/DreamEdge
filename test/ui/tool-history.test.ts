import assert from 'node:assert/strict';
import test from 'node:test';
import { uiFixture, send } from './fixture.js';
import { toolReply } from '../helpers/tool-loop.js';
import { chatReply } from '../helpers/server.js';

test('production host restores tool history after reload and restart without repeating calls', async t => {
  const f = await uiFixture(t, { tools: true, handler(response, request) {
    const messages = request.body.messages as { role: string }[];
    if (messages.at(-1)?.role === 'tool') chatReply(response);
    else toolReply(response, [{ id: 'addition', name: 'add_numbers', args: { a: 10, b: 20 } }]);
  } });
  let current = await f.launch(); await send(current.page, '历史中的计算');
  await current.page.waitForFunction(() => [...document.querySelectorAll('[data-testid="assistant-message"]')].at(-1)?.getAttribute('data-status') === 'completed');
  assert.equal(f.server.requests.length, 2);
  await current.page.getByTestId('tool-card').getByText('参数与详情').click();
  assert.ok((await current.page.getByTestId('tool-card').innerText()).includes('30'));
  await current.page.reload(); await current.page.locator('[data-testid="tool-card"][data-status="succeeded"]').waitFor();
  assert.equal(await current.page.getByTestId('tool-card').count(), 1); assert.equal(f.server.requests.length, 2);
  await current.app.close(); current = await f.launch();
  await current.page.locator('[data-testid="tool-card"][data-status="succeeded"]').waitFor();
  assert.equal(await current.page.getByTestId('tool-card').count(), 1); assert.equal(f.server.requests.length, 2);
  assert.ok((await current.page.getByTestId('assistant-message').last().innerText()).includes('Hello world'));
  assert.deepEqual(f.errors, []);
});
