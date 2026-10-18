import assert from 'node:assert/strict';
import test from 'node:test';
import { uiFixture } from './fixture.js';

test('activation during application exit does not reopen the chat window', { timeout: 20_000 }, async t => {
  const f = await uiFixture(t);
  const { app } = await f.launch();
  const child = app.process();
  await app.evaluate(({ app, BrowserWindow }) => {
    const chat = BrowserWindow.getAllWindows()[0]!;
    chat.show = () => { throw new Error('Cannot show the chat window during exit'); };
    app.once('before-quit', () => {
      app.emit('activate');
      app.emit('second-instance', {}, [], '', {});
    });
  });
  await app.close();
  assert.equal(child.exitCode, 0);
  assert.deepEqual(f.errors, []);
  assert.equal(f.server.requests.length, 0);
});
