import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, readFile, writeFile, symlink, link } from 'node:fs/promises';
import { join } from 'node:path';
import { providerResponse } from './provider-fixture';
import { ResponsesModel } from '../desktop/development/responses';
import { ProjectAccess } from '../desktop/development/project-access';
import { collectContext } from '../desktop/development/context';
import { fixture, proposal } from './development-fixture';

const configuration = { apiKey: 'fixture-agent-secret-key', model: 'fixture-model', baseUrl: 'https://model.example/v1' };
const call = (id: string, name: string, args: object) => ({ type: 'function_call', call_id: id, name, arguments: JSON.stringify(args) });
const answer = (value: unknown = proposal) => ({ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] });
const response = (...output: unknown[]) => providerResponse(output);

test('pi agent discovers, searches and reads project files without manual context, then stages a checksummed candidate', async () => {
  const f = await fixture(async () => proposal); const requests: any[] = []; let step = 0;
  const model = new ResponsesModel(configuration, async (_url, options) => {
    const body = JSON.parse(String(options!.body)); requests.push(body);
    assert.equal(new Headers(options!.headers).get('Authorization'), `Bearer ${configuration.apiKey}`);
    assert.ok(!JSON.stringify(body).includes(configuration.apiKey)); assert.equal(body.store, false);
    assert.deepEqual(body.tools.map((tool: any) => tool.name), ['list_files', 'read_file', 'search_files', 'resolve_dependency', 'set_dependencies', 'propose_changes']);
    if (++step === 1) return response(call('list', 'list_files', { directory: '', offset: 0 }));
    if (step === 2) return response({ type: 'reasoning', id: 'reason', encrypted_content: 'opaque', summary: [] }, call('search', 'search_files', { directory: '', query: 'original-greeting' }));
    if (step === 3) {
      assert.ok(JSON.stringify(body.input).includes('components/greeting.ts'));
      return response(call('read', 'read_file', { path: 'src/components/greeting.ts' }));
    }
    assert.ok(body.input.some((item: any) => item.type === 'reasoning' && item.encrypted_content === 'opaque'));
    return response(call('submit', 'propose_changes', { summary: 'Update nested greeting', files: [{ path: 'src/components/greeting.ts', content: 'export const greeting = "Hello Agent";' }] }));
  });
  f.provider.generate = (input, signal, access) => model.generate(input, signal, access);
  try {
    await mkdir(join(f.project.sourceDirectory, 'components'));
    await writeFile(join(f.project.sourceDirectory, 'components/greeting.ts'), 'export const greeting = "original-greeting";');
    await writeFile(join(f.project.sourceDirectory, 'unrelated.ts'), 'never-send-unrelated-content');
    await f.api.execute({ operation: 'send', projectId: f.project.definition.id, sessionId: f.session.id, prompt: 'Update greeting' });
    const turn = (await f.settled()).turns[0]; assert.equal(turn.status, 'completed', turn.error ?? '');
    assert.equal(step, 4); assert.deepEqual(turn.activity?.map(item => [item.tool, item.status]), [['list_files', 'completed'], ['search_files', 'completed'], ['read_file', 'completed']]);
    assert.equal(turn.context.length, 1); assert.equal(turn.changes[0].expectedHash, turn.context[0].hash);
    assert.ok(!JSON.stringify(requests).includes('never-send-unrelated-content')); assert.ok(!JSON.stringify(requests).includes(f.root));
    assert.equal(await readFile(join(f.project.sourceDirectory, 'components/greeting.ts'), 'utf8'), 'export const greeting = "original-greeting";');
    const candidate = await f.api.execute({ operation: 'candidate', projectId: f.project.definition.id, sessionId: f.session.id, turnId: turn.id });
    assert.ok('files' in candidate); assert.equal(candidate.files[0].before, 'export const greeting = "original-greeting";');
  } finally { await f.cleanup(); }
});
test('project tools reject escaping paths, linked files, changed reads and switched projects', async () => {
  const f = await fixture(async () => proposal);
  try {
    const context = await collectContext(f.project, []); const access = new ProjectAccess(f.workspace, f.project.definition.id, context); const signal = new AbortController().signal;
    await assert.rejects(access.execute('read_file', { path: '../secret' }, signal));
    await access.execute('read_file', { path: 'src/main.ts' }, signal);
    await writeFile(join(f.project.sourceDirectory, 'main.ts'), 'external change');
    await assert.rejects(access.execute('read_file', { path: 'src/main.ts' }, signal), /发生变化/);
    await writeFile(join(f.root, 'secret.txt'), 'outside-secret');
    await symlink(join(f.root, 'secret.txt'), join(f.project.sourceDirectory, 'linked.ts'));
    await assert.rejects(access.execute('read_file', { path: 'src/linked.ts' }, signal), /链接/);
    await link(join(f.root, 'secret.txt'), join(f.project.sourceDirectory, 'hard.ts'));
    await assert.rejects(access.execute('read_file', { path: 'src/hard.ts' }, signal), /链接/);
    await f.workspace.execute({ operation: 'create', directory: join(f.root, 'other'), name: 'Other' });
    await assert.rejects(access.execute('list_files', { directory: '', offset: 0 }, signal), /当前工程/);
  } finally { await f.cleanup(); }
});
test('pi validates tool arguments, returns tool errors to the model and rejects stale candidates', async () => {
  const f = await fixture(async () => proposal); let step = 0;
  const model = new ResponsesModel(configuration, async (_url, options) => {
    const body = JSON.parse(String(options!.body));
    if (++step === 1) return response(call('schema', 'read_file', { path: 7 }));
    if (step === 2) {
      assert.ok(body.input.some((item: any) => item.type === 'function_call_output' && String(item.output).includes('schema')));
      return response(call('bad', 'read_file', { path: '../outside' }));
    }
    if (step === 3) return response(call('read', 'read_file', { path: 'src/main.ts' }));
    await writeFile(join(f.project.sourceDirectory, 'main.ts'), 'external edit'); return response(call('submit', 'propose_changes', proposal));
  });
  f.provider.generate = (input, signal, access) => model.generate(input, signal, access);
  try {
    await f.api.execute({ operation: 'send', projectId: f.project.definition.id, sessionId: f.session.id, prompt: 'Change greeting' });
    const turn = (await f.settled()).turns[0]; assert.equal(turn.status, 'failed'); assert.equal(turn.activity?.[0].status, 'failed');
    assert.equal(await readFile(join(f.project.sourceDirectory, 'main.ts'), 'utf8'), 'external edit');
  } finally { await f.cleanup(); }
});
test('credentials in automatically read source never enter tool output, context snapshots or candidates', async () => {
  const f = await fixture(async () => proposal); let step = 0;
  const model = new ResponsesModel(configuration, async (_url, options) => {
    assert.ok(!String(options!.body).includes(configuration.apiKey));
    if (++step === 1) return response(call('read', 'read_file', { path: 'src/main.ts' }));
    return response(call('submit', 'propose_changes', { summary: 'Cannot read credentials', files: [] }));
  });
  f.provider.generate = (input, signal, access) => model.generate(input, signal, access);
  try {
    await writeFile(join(f.project.sourceDirectory, 'main.ts'), configuration.apiKey);
    await f.api.execute({ operation: 'send', projectId: f.project.definition.id, sessionId: f.session.id, prompt: 'Inspect source' });
    const turn = (await f.settled()).turns[0]; assert.equal(turn.activity?.[0].status, 'failed'); assert.deepEqual(turn.context, []);
    const snapshot = await readFile(join(f.project.sessionsDirectory, f.session.id, turn.id, 'request-context.json'), 'utf8');
    assert.ok(!snapshot.includes(configuration.apiKey)); assert.ok(!JSON.stringify(turn).includes(configuration.apiKey));
  } finally { await f.cleanup(); }
});
test('unending tool requests hit a bounded loop budget and cancellation prevents another model request', async () => {
  let requests = 0; const events: unknown[] = []; const controller = new AbortController();
  const model = new ResponsesModel(configuration, async () => response(call(`call${++requests}`, 'list_files', { directory: '', offset: 0 })));
  const input = { prompt: 'Inspect', context: { definition: (await import('../desktop/workspace/definition')).createDefinition('Test'), files: [] }, history: [] };
  const access = { execute: async () => ({ files: [] }), activity: async (event: unknown) => { events.push(event); } };
  await assert.rejects(model.generate(input, controller.signal, access), /12 次/); assert.equal(requests, 12);
  requests = 0; events.length = 0;
  await assert.rejects(model.generate(input, controller.signal, { ...access, execute: async () => { controller.abort(); return {}; } }));
  assert.equal(requests, 1);
});
