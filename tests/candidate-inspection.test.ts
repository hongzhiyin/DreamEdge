import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CandidateInspection, DevelopmentSessionSummary } from '../shared/contracts';
import { fixture, proposal } from './development-fixture';
import { CandidateBuildApi } from '../desktop/build/api';
import { compile } from '../desktop/build/compiler';

test('candidate inspection shows the captured original source and marks stale source and metadata without overwriting it', async () => {
  const f = await fixture(async () => proposal);
  const builds = new CandidateBuildApi(f.workspace, input => compile(input), async () => {});
  try {
    const original = await readFile(join(f.project.sourceDirectory, 'main.ts'), 'utf8');
    await f.send(); const session = await f.settled(); const reference = { sessionId: session.id, turnId: session.turns[0].id };
    const inspect = () => f.api.execute({ operation: 'candidate', projectId: f.project.definition.id, ...reference }) as Promise<CandidateInspection>;
    const first = await inspect(); assert.equal(first.stale, false); assert.equal(first.files[0].before, original); assert.equal(first.files[0].after, proposal.files[0].content);
    const summaries = await f.api.execute({ operation: 'listSummaries', projectId: f.project.definition.id }) as DevelopmentSessionSummary[];
    assert.equal(summaries[0].turnCount, 1); assert.ok(!JSON.stringify(summaries).includes(proposal.files[0].content));
    await writeFile(join(f.project.sourceDirectory, 'main.ts'), 'User edit');
    assert.equal((await inspect()).stale, true); assert.equal((await inspect()).files[0].before, original);
    await assert.rejects(builds.execute({ operation: 'start', projectId: f.project.definition.id, candidate: reference }), /过期/);
    await writeFile(join(f.project.sourceDirectory, 'main.ts'), original);
    await f.workspace.execute({ operation: 'save', projectId: f.project.definition.id, version: '0.2.0' });
    assert.equal((await inspect()).stale, true);
    await assert.rejects(builds.execute({ operation: 'start', projectId: f.project.definition.id, candidate: reference }), /过期/);
  } finally { await builds.dispose(); await f.cleanup(); }
});
test('candidate snapshots reject altered base content instead of advertising a misleading diff', async () => {
  const f = await fixture(async () => proposal);
  try {
    await f.send(); const session = await f.settled(); const turn = session.turns[0];
    const path = join(f.project.sessionsDirectory, session.id, turn.id, 'request-context.json');
    const context = JSON.parse(await readFile(path, 'utf8')); context.files[0].content = 'tampered'; await writeFile(path, JSON.stringify(context));
    await assert.rejects(f.api.execute({ operation: 'candidate', projectId: f.project.definition.id, sessionId: session.id, turnId: turn.id }), /快照已变化/);
  } finally { await f.cleanup(); }
});

test('credential guards reject session titles and prompts before those values reach session storage', async () => {
  const { ModelSettings } = await import('../desktop/model-connection/settings');
  const { ProjectConnectionFile, EMPTY_REVISION } = await import('../desktop/model-connection/file');
  const { DevelopmentApi } = await import('../desktop/development/api');
  const f = await fixture(async () => proposal); const secret = 'fixture-connection-key';
  const settings = new ModelSettings(new ProjectConnectionFile(f.project.rootDirectory), f.project.definition.id);
  const api = new DevelopmentApi(f.workspace, settings);
  try {
    await settings.execute({ operation: 'save', apiKey: secret, model: 'fixture-model', baseUrl: 'https://model.example/v1', projectId: f.project.definition.id, expectedRevision: EMPTY_REVISION });
    await assert.rejects(api.execute({ operation: 'create', projectId: f.project.definition.id, title: secret }), /凭据/);
    await assert.rejects(api.execute({ operation: 'send', projectId: f.project.definition.id, sessionId: f.session.id, prompt: secret, paths: ['main.ts'] }), /凭据/);
    const session = await f.get(); assert.equal(session.turns.length, 0); assert.ok(!JSON.stringify(session).includes(secret));
  } finally { await api.dispose(); await settings.dispose(); await f.cleanup(); }
});
