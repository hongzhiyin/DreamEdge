import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile, stat, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ModelSettingsState } from '../shared/contracts';
import { EMPTY_REVISION, MODEL_FILE, ProjectConnectionFile } from '../desktop/model-connection/file';
import { ModelSettings } from '../desktop/model-connection/settings';
import { createDefinition } from '../desktop/workspace/definition';
import { deferred, proposal } from './development-fixture';

const projectId = 'fixture-project';
const settings = { operation: 'save' as const, projectId, model: 'fixture-model', baseUrl: 'https://model.example/v1/', apiKey: 'fixture-private-key', expectedRevision: EMPTY_REVISION };
const input = { prompt: 'Change greeting', context: { definition: createDefinition('HelloWorld'), files: [] }, history: [] };
const response = () => Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(proposal) }] }] });
async function fixture(transport?: typeof fetch) {
  const root = await mkdtemp(join(tmpdir(), 'dreamedge-model-settings-'));
  const service = new ModelSettings(new ProjectConnectionFile(root), projectId, () => {}, transport);
  return { root, service, path: join(root, MODEL_FILE), get: () => service.execute({ operation: 'get', projectId }) as Promise<ModelSettingsState>,
    cleanup: async () => { await service.dispose(); await rm(root, { recursive: true, force: true }); } };
}
test('project configuration is editable on disk, excluded from git and returned as metadata without the key', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, '.gitignore'), 'existing-rule\n');
    const saved = await f.service.execute(settings) as ModelSettingsState;
    assert.equal(saved.hasKey, true); assert.equal(saved.baseUrl, 'https://model.example/v1'); assert.equal(saved.configPath, f.path);
    assert.ok(!JSON.stringify(saved).includes(settings.apiKey));
    assert.deepEqual(JSON.parse(await readFile(f.path, 'utf8')), { schemaVersion: 1, model: settings.model, baseUrl: 'https://model.example/v1', apiKey: settings.apiKey });
    assert.equal(await readFile(join(f.root, '.gitignore'), 'utf8'), 'existing-rule\n/.dreamedge/model.json\n');
    if (process.platform !== 'win32') assert.equal((await stat(f.path)).mode & 0o777, 0o600);
    const restored = new ModelSettings(new ProjectConnectionFile(f.root), projectId);
    assert.deepEqual(await restored.execute({ operation: 'get', projectId }), saved); await restored.dispose();
    await f.service.execute({ operation: 'clear', projectId, expectedRevision: saved.revision });
    assert.equal((await f.get()).hasKey, false); await assert.rejects(readFile(f.path), { code: 'ENOENT' });
  } finally { await f.cleanup(); }
});
test('external edits reload without a restart and stale forms cannot overwrite manually changed keys or URLs', async () => {
  const calls: any[] = [];
  const f = await fixture(async (url, options) => { calls.push({ url: String(url), auth: new Headers(options!.headers).get('Authorization') }); return response(); });
  try {
    const original = await f.service.execute(settings) as ModelSettingsState;
    await writeFile(f.path, JSON.stringify({ schemaVersion: 1, model: 'other-model', apiKey: 'other-key', baseUrl: 'https://other.example/v1' }));
    await assert.rejects(f.service.execute({ ...settings, expectedRevision: original.revision }), /已被修改/);
    await assert.rejects(f.service.execute({ operation: 'test', projectId, expectedRevision: original.revision }), /已被修改/);
    const state = await f.get(); assert.equal(state.model, 'other-model'); assert.notEqual(state.revision, original.revision);
    await f.service.generate(input, new AbortController().signal);
    assert.deepEqual(calls, [{ url: 'https://other.example/v1/responses', auth: 'Bearer other-key' }]);
  } finally { await f.cleanup(); }
});
test('invalid and linked configuration files fail closed without exposing their content or overwriting targets', async () => {
  const f = await fixture();
  try {
    await f.service.execute(settings); await writeFile(f.path, '{ invalid fixture-private-key');
    const invalid = await f.get(); assert.equal(invalid.hasKey, false); assert.ok(invalid.warning); assert.ok(!JSON.stringify(invalid).includes(settings.apiKey));
    await assert.rejects(f.service.generate(input, new AbortController().signal), /格式无效/);
    await f.service.execute({ ...settings, expectedRevision: invalid.revision });
    await rm(f.path); await writeFile(join(f.root, 'secret.txt'), 'outside-secret'); await symlink(join(f.root, 'secret.txt'), f.path);
    assert.equal((await f.get()).hasKey, false);
    await assert.rejects(f.service.execute({ ...settings, expectedRevision: EMPTY_REVISION }));
    assert.equal(await readFile(join(f.root, 'secret.txt'), 'utf8'), 'outside-secret');
  } finally { await f.cleanup(); }
});
test('settings belong to one project and require a new key when changing service addresses', async () => {
  const f = await fixture();
  try {
    const first = await f.service.execute(settings) as ModelSettingsState;
    await assert.rejects(f.service.execute({ ...settings, projectId: 'other' }), /当前工程/);
    await assert.rejects(f.service.execute({ ...settings, expectedRevision: first.revision, baseUrl: 'https://other.example/v1', apiKey: '' }), /重新填写/);
    const next = await f.service.execute({ ...settings, expectedRevision: first.revision, model: 'another-model', apiKey: '' }) as ModelSettingsState;
    assert.equal(next.model, 'another-model'); assert.equal(next.hasKey, true);
  } finally { await f.cleanup(); }
});
test('connection tests use no project source and HTTP 401 reports authentication rather than quota', async () => {
  let fail = false;
  const f = await fixture(async (_url, options) => {
    const body = JSON.parse(String(options!.body)); assert.equal(body.text.format.name, 'dreamedge_connection');
    assert.equal(body.store, false); assert.ok(!JSON.stringify(body).includes(settings.apiKey)); assert.ok(!JSON.stringify(body).includes('src/'));
    if (fail) return new Response(settings.apiKey, { status: 401 });
    return Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '{"ok":true}' }] }] });
  });
  try {
    const state = await f.service.execute(settings) as ModelSettingsState;
    assert.equal((await f.service.execute({ operation: 'test', projectId, expectedRevision: state.revision }) as { available: boolean }).available, true);
    fail = true; const result = await f.service.execute({ operation: 'test', projectId, expectedRevision: state.revision });
    assert.match(JSON.stringify(result), /认证失败.*401/); assert.ok(!JSON.stringify(result).includes('服务限额')); assert.ok(!JSON.stringify(result).includes(settings.apiKey));
  } finally { await f.cleanup(); }
});
test('in-flight requests keep their captured key while new requests use changed project configuration', async () => {
  const answer = deferred<Response>(); const calls: { url: string; key: string | null }[] = [];
  const f = await fixture(async (url, options) => { calls.push({ url: String(url), key: new Headers(options!.headers).get('Authorization') }); return calls.length === 1 ? answer.promise : response(); });
  try {
    const state = await f.service.execute(settings) as ModelSettingsState; const old = f.service.generate(input, new AbortController().signal);
    while (!calls.length) await new Promise(resolve => setTimeout(resolve, 1));
    await f.service.execute({ ...settings, apiKey: 'fixture-other-key', baseUrl: 'https://other.example/v1', expectedRevision: state.revision });
    answer.resolve(response()); await old; await f.service.generate(input, new AbortController().signal);
    assert.deepEqual(calls, [{ url: 'https://model.example/v1/responses', key: 'Bearer fixture-private-key' }, { url: 'https://other.example/v1/responses', key: 'Bearer fixture-other-key' }]);
    await assert.rejects(f.service.assertSafeInput({ ...input, prompt: 'fixture-other-key' }), /凭据/);
  } finally { answer.resolve(response()); await f.cleanup(); }
});
test('clearing project configuration stops active tests even when transport ignores abort', async () => {
  const f = await fixture(async () => new Promise(() => {}));
  try {
    const state = await f.service.execute(settings) as ModelSettingsState;
    const waiting = f.service.execute({ operation: 'test', projectId, expectedRevision: state.revision });
    await new Promise(resolve => setTimeout(resolve, 10)); await f.service.execute({ operation: 'clear', projectId, expectedRevision: state.revision });
    const result = await waiting as { available: boolean; detail: string }; assert.equal(result.available, false); assert.match(result.detail, /已清除/);
  } finally { await f.cleanup(); }
});
test('model metadata and echoed replies cannot expose the configured key', async () => {
  const f = await fixture(async () => Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ summary: settings.apiKey, files: [] }) }] }] }));
  try {
    await assert.rejects(f.service.execute({ ...settings, model: settings.apiKey }), /不能包含/);
    await assert.rejects(f.service.execute({ ...settings, baseUrl: 'https://model.example/' + settings.apiKey }), /不能包含/);
    await f.service.execute(settings); await assert.rejects(f.service.generate(input, new AbortController().signal), /回复包含连接凭据/);
  } finally { await f.cleanup(); }
});

test('independent project windows never share model keys and stale project requests are rejected', async () => {
  const { ProjectModels } = await import('../desktop/model-connection/project');
  const { fixture: developmentFixture } = await import('./development-fixture');
  const f = await developmentFixture(async () => proposal);
  const a = new ProjectModels(() => f.project, () => {}); let b: InstanceType<typeof ProjectModels> | undefined;
  try {
    await a.execute({ ...settings, projectId: f.project.definition.id });
    const other = await f.workspace.execute({ operation: 'create', directory: join(f.root, 'second'), name: 'Second' }) as import('../shared/contracts').WorkspaceProject;
    b = new ProjectModels(() => other, () => {});
    const empty = await b.execute({ operation: 'get', projectId: other.definition.id }) as ModelSettingsState;
    assert.equal(empty.hasKey, false);
    assert.throws(() => b!.execute({ operation: 'get', projectId: f.project.definition.id }), /当前工程/);
    await b.execute({ ...settings, projectId: other.definition.id, apiKey: 'other-project-key' });
    assert.equal(JSON.parse(await readFile(join(f.project.rootDirectory, MODEL_FILE), 'utf8')).apiKey, settings.apiKey);
    assert.equal(JSON.parse(await readFile(join(other.rootDirectory, MODEL_FILE), 'utf8')).apiKey, 'other-project-key');
  } finally { await a.reset(); await b?.reset(); await f.cleanup(); }
});
