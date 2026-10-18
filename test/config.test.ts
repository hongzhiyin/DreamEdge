import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCredentialResolver, ModelAdapterError, parseModelConnection, PiRuntime } from '../src/index.js';
import { connection, deadline, request } from './helpers/server.js';

test('connection validation rejects plaintext credentials, malformed endpoints and incompatible limits', () => {
  const base = connection('http://127.0.0.1:1');
  for (const input of [
    { ...base, apiKey: 'fixture-key' }, { ...base, protocol: 'unknown' },
    { ...base, baseUrl: 'https://user:password@example.com' },
    { ...base, baseUrl: 'https://example.com?apiKey=fixture-key' },
    { ...base, maxOutputTokens: base.contextWindow + 1 },
    { ...base, timeoutMs: 2_147_483_648 },
    { ...base, reasoning: { supportedLevels: ['high'], effortMap: { high: null } } },
  ]) {
    assert.throws(() => parseModelConnection(input), (error: unknown) =>
      error instanceof ModelAdapterError && error.code === 'INVALID_CONFIG');
  }
});

test('unsupported thinking fails before credential access or model dispatch', async () => {
  let accessed = false;
  const base = connection('http://127.0.0.1:1', { reasoning: { supportedLevels: ['off', 'low'] } });
  const result = await new PiRuntime(base, async () => { accessed = true; return 'fixture-key'; })
    .start(request()).done;
  assert.equal(result.status, 'failed');
  assert.equal(result.error?.code, 'UNSUPPORTED_THINKING');
  assert.equal(accessed, false);
});

test('missing or unreadable credentials return controlled errors without disclosing resolver details', async () => {
  const base = connection('http://127.0.0.1:1');
  const missing = await new PiRuntime(base, async () => undefined).start(request()).done;
  assert.equal(missing.error?.code, 'MISSING_CREDENTIAL');
  const failed = await new PiRuntime(base, async () => { throw new Error('resolver leaked fixture-key'); })
    .start(request()).done;
  assert.equal(failed.error?.code, 'CREDENTIAL_ACCESS_FAILED');
  assert.ok(!JSON.stringify(failed).includes('fixture-key'));
});

test('cancel settles even while credential resolution is pending', async () => {
  const runtime = new PiRuntime(connection('http://127.0.0.1:1'), () => new Promise(() => undefined));
  const handle = runtime.start(request());
  handle.cancel();
  assert.equal((await deadline(handle.done)).status, 'cancelled');
});

test('invalid context is rejected before any credential access', async () => {
  let accessed = false;
  const runtime = new PiRuntime(connection('http://127.0.0.1:1'), async () => {
    accessed = true; return 'fixture-key';
  });
  const result = await runtime.start({ ...request(), messages: [] }).done;
  assert.equal(result.error?.code, 'INVALID_CONTEXT');
  assert.equal(accessed, false);
});

test('credentials resolve only from the specified environment or private file', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'dreamedge-credentials-'));
  const file = join(folder, 'keys.json');
  t.after(async () => { await unlink(file); await rmdir(folder); });
  await writeFile(file, JSON.stringify({ deepseek: 'fixture-key' }), { mode: 0o600 });
  const signal = new AbortController().signal;
  const resolve = createCredentialResolver({ credentialsFile: file, environment: { FIXTURE_KEY: 'environment-key' } });
  assert.equal(await resolve('file:deepseek', signal), 'fixture-key');
  assert.equal(await resolve('env:FIXTURE_KEY', signal), 'environment-key');
  assert.equal(await resolve('file:missing', signal), undefined);
  assert.equal(await resolve('env:MISSING_KEY', signal), undefined);
});

test('DeepSeek sample uses the current model name and high thinking; tracked credentials template is empty', async () => {
  const config = parseModelConnection(JSON.parse(await readFile('config/deepseek.example.json', 'utf8')));
  assert.equal(config.model, 'deepseek-flash');
  assert.equal(config.baseUrl, 'https://api.deepseek.com');
  assert.equal(config.thinkingLevel, 'high');
  assert.equal(config.reasoning?.format, 'deepseek');
  const example = JSON.parse(await readFile('config/credentials.example.json', 'utf8')) as { deepseek: string };
  assert.equal(example.deepseek, '');
});
