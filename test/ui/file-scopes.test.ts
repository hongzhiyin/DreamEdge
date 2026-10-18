import assert from 'node:assert/strict';
import test from 'node:test';
import { uiFixture } from './fixture.js';

test('desktop account access is automatic, durable and cannot be replaced by renderer directory commands', async t => {
  const f = await uiFixture(t); const { app, page } = await f.launch();
  await app.evaluate(({ dialog }) => { dialog.showOpenDialog = (async () => { throw new Error('Unexpected chooser'); }) as typeof dialog.showOpenDialog; });
  const s = await page.evaluate(() => window.dreamedge.createSession());
  const before = await page.evaluate(id => window.dreamedge.fileScopes!(id), s.sessionId);
  assert.ok(before.grants.some(g => g.device));
  await assert.rejects(page.evaluate(id => window.dreamedge.chooseDirectory!(id, { mode: 'read', remember: true }), s.sessionId));
  await assert.rejects(page.evaluate(id => window.dreamedge.setDeviceAccess!(id, false), s.sessionId));
  await assert.rejects(page.evaluate(({ id, grant }) => window.dreamedge.revokeDirectory!(id, grant),
    { id: s.sessionId, grant: before.grants[0]!.grantId }));
  await app.close(); const restored = await f.launch();
  const after = await restored.page.evaluate(id => window.dreamedge.fileScopes!(id), s.sessionId);
  assert.deepEqual(after, before); assert.equal(f.server.requests.length, 0); assert.equal(f.errors.length, 0);
});
