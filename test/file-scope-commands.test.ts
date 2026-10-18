import assert from 'node:assert/strict';
import test from 'node:test';
import { ConversationService } from '../src/index.js';
import { fileScopeCommand } from '../src/files/scope-command.js';
import { connection } from './helpers/server.js';

test('renderer commands cannot inject grant paths, identities, destinations or tool bindings', () => {
  for (const value of [
    { type: 'choose', sessionId: 's', path: '/tmp', options: { mode: 'read', remember: false } },
    { type: 'choose', sessionId: 's', options: { mode: 'read', remember: false, path: '/tmp' } },
    { type: 'choose', sessionId: 's', options: { mode: 'all', remember: false } },
    { type: 'choose', sessionId: 's', options: { mode: 'read', remember: 'yes' } },
    { type: 'choose', sessionId: 's', options: { mode: 'read', remember: false, excludes: ['../secret'] } },
    { type: 'revoke', sessionId: 's', grantId: 'g', policyVersion: 1 },
    { type: 'snapshot', sessionId: 's', destination: 'model' },
    { type: 'read', sessionId: 's', path: '/tmp/secret' },
  ]) assert.throws(() => fileScopeCommand(value), { code: 'FILE_SCOPE_INVALID' });
  assert.deepEqual(fileScopeCommand({ type: 'choose', sessionId: 's', options: { mode: 'read', remember: false } }),
    { type: 'choose', sessionId: 's', options: { mode: 'read', remember: false } });
});
test('missing native picker is denied and policy inspection does not mutate a conversation', async () => {
  const service = new ConversationService({ connection: () => connection('http://127.0.0.1:1'), runtime: () => { throw 0; } });
  const s = service.createSession({ connectionId: 'fixture' }); const before = service.getSnapshot(s.sessionId);
  assert.equal(service.fileScopes.snapshot(s.sessionId).policyVersion, 0);
  assert.deepEqual(service.getSnapshot(s.sessionId), before);
  await assert.rejects(service.fileScopes.chooseDirectory(s.sessionId, { mode: 'read', remember: false }), { code: 'FILE_SCOPE_DENIED' });
  await service.dispose();
});
