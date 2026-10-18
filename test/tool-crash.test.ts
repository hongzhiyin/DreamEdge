import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ConversationService } from '../src/index.js';
import { deadline } from './helpers/server.js';
import { toolConversation, toolStoreFixture } from './helpers/tool-storage.js';

test('SIGKILL after a committed write intent recovers an unknown outcome without executing anything', async t => {
  const f = await toolStoreFixture(t); f.store.close();
  const child = spawn(process.execPath, [fileURLToPath(new URL('./helpers/tool-storage-crash.js', import.meta.url)), f.path],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { child.kill('SIGKILL'); });
  let diagnostics = '';
  child.stderr.on('data', chunk => { diagnostics += String(chunk); });
  const exited = new Promise<void>((resolve, reject) => { child.once('error', reject); child.once('exit', () => resolve()); });
  const ready = new Promise<void>((resolve, reject) => {
    let output = '';
    child.stdout.on('data', chunk => { output += String(chunk); if (output.includes('TOOL_INTENT_COMMITTED')) resolve(); });
    child.once('error', reject); child.once('exit', () => reject(new Error(diagnostics)));
  });
  await deadline(ready, 5000); child.kill('SIGKILL'); await deadline(exited);
  let dispatches = 0;
  const store = f.open();
  const service = new ConversationService({ store, connection: () => toolConversation().runs[0]!.modelConfigSnapshot,
    runtime: () => ({ start() { dispatches++; throw new Error('Recovery cannot start a runtime'); } }) });
  t.after(async () => { await service.dispose(); });
  const recovered = service.getSnapshot('s').runs[0]!;
  assert.equal(recovered.status, 'interrupted'); assert.equal(recovered.toolCalls![0]!.status, 'outcome_unknown');
  assert.equal(dispatches, 0); assert.deepEqual(store.load()[0]!.runs[0], recovered);
});
