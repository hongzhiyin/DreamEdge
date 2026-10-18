import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionPersistence } from '../src/conversation/persistence.js';
import type { SessionState } from '../src/conversation/state.js';
import { toolConversation, toolStoreFixture } from './helpers/tool-storage.js';

test('durable tool barrier waits for save retry and cannot release on an older version', async t => {
  const f = await toolStoreFixture(t);
  const data = toolConversation(); f.store.save(data, null);
  const state: SessionState = { ...data, submissions: new Map(), notify() {}, saveState: { status: 'saved', savedVersion: 1 } };
  const persistence = new SessionPersistence(f.store);
  state.session.version = 2;
  f.faults.exec(`CREATE TRIGGER fail_commit BEFORE UPDATE ON sessions
    BEGIN SELECT RAISE(ABORT, 'fixture'); END`);
  let released = false;
  const pending = persistence.commit(state, new AbortController().signal).then(result => { released = result; return result; });
  await Promise.resolve(); assert.equal(released, false); assert.equal(state.saveState.status, 'failed');
  assert.equal(f.store.load()[0]!.session.version, 1);
  f.faults.exec('DROP TRIGGER fail_commit');
  assert.equal(persistence.flush(state, true), true);
  assert.equal(await pending, true); assert.equal(f.store.load()[0]!.session.version, 2);
});

test('cancelling a save barrier never runs its guarded continuation after later save recovery', async t => {
  const f = await toolStoreFixture(t);
  const data = toolConversation(); f.store.save(data, null);
  const state: SessionState = { ...data, submissions: new Map(), notify() {}, saveState: { status: 'saved', savedVersion: 1 } };
  const persistence = new SessionPersistence(f.store); state.session.version = 2;
  f.faults.exec(`CREATE TRIGGER fail_commit BEFORE UPDATE ON sessions
    BEGIN SELECT RAISE(ABORT, 'fixture'); END`);
  const abort = new AbortController(); let actions = 0;
  const pending = persistence.commit(state, abort.signal).then(ready => { if (ready) actions++; return ready; });
  abort.abort(); assert.equal(await pending, false);
  f.faults.exec('DROP TRIGGER fail_commit'); persistence.flush(state, true);
  await Promise.resolve(); assert.equal(actions, 0);
});
