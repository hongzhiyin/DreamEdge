import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { providerResponse } from './provider-fixture';
import { ResponsesModel } from '../desktop/development/responses';
import { fixture, proposal } from './development-fixture';

const configuration = { apiKey: 'fixture-proposal-key', model: 'deepseek-flash', baseUrl: 'https://api.deepseek.com' };
const call = (id: string, name: string, args: unknown) => ({ type: 'function_call', call_id: id, name, arguments: JSON.stringify(args) });
const response = (...output: unknown[]) => providerResponse(output);
const prose = (text: string) => ({ type: 'message', content: [{ type: 'output_text', text }] });

test('a fenced or explanatory final reply is corrected through the proposal tool without repeating file reads', async () => {
  const f = await fixture(async () => proposal); const requests: any[] = []; let step = 0;
  const model = new ResponsesModel(configuration, async (_url, options) => {
    const body = JSON.parse(String(options!.body)); requests.push(body);
    assert.equal(body.text, undefined);
    const tool = body.tools.find((tool: any) => tool.name === 'propose_changes'); assert.equal(tool.strict, true); assert.equal(tool.parameters.additionalProperties, false);
    if (++step === 1) return response(call('read', 'read_file', { path: 'src/main.ts' }));
    if (step === 2) return response(prose('I will make the change.\n```json\n' + JSON.stringify(proposal) + '\n```'));
    assert.ok(JSON.stringify(body.input).includes('was not submitted as a candidate'));
    return response(call('submit', 'propose_changes', proposal));
  });
  f.provider.generate = (input, signal, access) => model.generate(input, signal, access);
  try {
    const original = await readFile(join(f.project.sourceDirectory, 'main.ts'), 'utf8');
    await f.api.execute({ operation: 'send', projectId: f.project.definition.id, sessionId: f.session.id, prompt: 'Change greeting' });
    const turn = (await f.settled()).turns[0]; assert.equal(turn.status, 'completed', turn.error ?? '');
    assert.equal(step, 3); assert.equal(turn.activity?.length, 1); assert.equal(turn.changes[0].expectedHash, turn.context[0].hash);
    assert.equal(await readFile(join(f.project.sourceDirectory, 'main.ts'), 'utf8'), original);
    assert.ok(!JSON.stringify(requests).includes(configuration.apiKey));
  } finally { await f.cleanup(); }
});
test('pi rejects malformed and unread-file proposals and the model can correct the submission in the same turn', async () => {
  const f = await fixture(async () => proposal); let step = 0;
  const model = new ResponsesModel(configuration, async (_url, options) => {
    const body = JSON.parse(String(options!.body));
    if (++step === 1) return response(call('malformed', 'propose_changes', { summary: 'Bad', files: [{ path: 'src/main.ts', content: 7 }] }));
    if (step === 2) {
      assert.ok(body.input.some((item: any) => item.type === 'function_call_output' && String(item.output).includes('schema')));
      return response(call('unread', 'propose_changes', proposal));
    }
    if (step === 3) {
      assert.ok(JSON.stringify(body.input).includes('未提供上下文'));
      return response(call('read', 'read_file', { path: 'src/main.ts' }));
    }
    return response(call('submit', 'propose_changes', proposal));
  });
  f.provider.generate = (input, signal, access) => model.generate(input, signal, access);
  try {
    await f.api.execute({ operation: 'send', projectId: f.project.definition.id, sessionId: f.session.id, prompt: 'Change greeting' });
    const turn = (await f.settled()).turns[0]; assert.equal(turn.status, 'completed', turn.error ?? ''); assert.equal(step, 4);
    assert.equal(turn.changes.length, 1);
  } finally { await f.cleanup(); }
});
test('empty or repeated prose replies stop after two submission reminders and never become a candidate', async () => {
  const f = await fixture(async () => proposal); let requests = 0;
  const model = new ResponsesModel(configuration, async () => { requests++; return response(prose(requests === 1 ? '' : 'Done.')); });
  f.provider.generate = (input, signal, access) => model.generate(input, signal, access);
  try {
    await f.api.execute({ operation: 'send', projectId: f.project.definition.id, sessionId: f.session.id, prompt: 'Change greeting' });
    const turn = (await f.settled()).turns[0]; assert.equal(turn.status, 'failed'); assert.match(turn.error!, /候选工具/);
    assert.equal(requests, 3); assert.deepEqual(turn.changes, []);
    assert.ok((await readFile(join(f.project.sourceDirectory, 'main.ts'), 'utf8')).includes('HelloWorld'));
  } finally { await f.cleanup(); }
});
