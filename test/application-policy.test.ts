import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { automaticApplicationAccess } from '../src/launch/application-policy.js';
import { modelDestination } from '../src/model/destination.js';
import { connection } from './helpers/server.js';
import { launchProtocol, parseLaunchRequest, type OpenSession } from '../src/launch/protocol.js';

test('only a local exact application/entry/model/tool policy bypasses the launch dialog', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'app-policy-')), file = join(dir, 'policy.json'), config = connection('http://127.0.0.1:3000');
  const request: OpenSession = { protocol: launchProtocol, operation: 'open-session', requestId: 'r',
    application: { id: 'example.viewer', name: 'Viewer', profile: 'default' }, context: { window: 'w1', resource: 'r1' },
    mcp: { transport: { type: 'stdio', command: '/apps/viewer', args: ['mcp', 'w1', 'r1'] }, scope: 'Current resource', readTools: ['read'], interactionTools: ['navigate'] } };
  const allowed = (value = request) => automaticApplicationAccess(file, value, config);
  try {
    assert.equal(allowed(), false);
    await writeFile(file, JSON.stringify({ format: 'ai-application-policies/v1', applications: [{
      applicationId: 'example.viewer', profile: 'default', command: '/apps/viewer', destination: modelDestination(config),
      args: ['mcp', { context: 'window' }, { context: 'resource' }], readTools: ['read'], interactionTools: ['navigate'],
    }] }));
    assert.equal(allowed(), true);
    assert.equal(allowed({ ...request, application: { ...request.application, id: 'other' } }), false);
    assert.equal(allowed({ ...request, mcp: { ...request.mcp!, interactionTools: ['delete'] } }), false);
    assert.equal(allowed({ ...request, mcp: { ...request.mcp!, transport: { ...request.mcp!.transport, command: '/other' } } }), false);
    assert.equal(allowed({ ...request, mcp: { ...request.mcp!, transport: { ...request.mcp!.transport, args: ['mcp', 'other', 'r1'] } } }), false);
    assert.throws(() => parseLaunchRequest({ ...request, approved: true }));
    assert.throws(() => parseLaunchRequest({ ...request, mcp: { ...request.mcp!, interactionTools: ['read'] } }));
    config.model = 'other-model'; assert.equal(allowed(), false);
    await writeFile(file, '{broken'); assert.equal(allowed(), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
