import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ModelSettingsState } from '../shared/contracts';
import { ConnectionVault, type SecretEncryption } from '../desktop/model-connection/vault';
import { ModelSettings } from '../desktop/model-connection/settings';
import { createDefinition } from '../desktop/workspace/definition';
import { deferred, proposal } from './development-fixture';

function encryption(): SecretEncryption {
  const key = randomBytes(32);
  return { supported: true, available: () => true,
    encrypt: value => { const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, iv);
      const bytes = Buffer.concat([cipher.update(value), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), bytes]); },
    decrypt: value => { const decipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12));
      decipher.setAuthTag(value.subarray(12, 28)); return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString(); } };
}
const settings = { operation: 'save' as const, model: 'fixture-model', baseUrl: 'https://model.example/v1/', apiKey: 'fixture-private-key', persist: true, expectedRevision: 0 };
const input = { prompt: 'Change greeting', context: { definition: createDefinition('HelloWorld'), files: [] }, history: [] };
const response = () => Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(proposal) }] }] });

test('model settings persist an encrypted key, return only public metadata and restore without leaking it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dreamedge-model-settings-')); const codec = encryption();
  try {
    const service = new ModelSettings(new ConnectionVault(root, codec));
    const saved = await service.execute(settings) as ModelSettingsState;
    assert.equal(saved.hasKey, true); assert.equal(saved.persisted, true); assert.equal(saved.baseUrl, 'https://model.example/v1');
    assert.ok(!JSON.stringify(saved).includes(settings.apiKey));
    const path = join(root, 'model-connection/settings.json'); const content = await readFile(path, 'utf8');
    assert.ok(!content.includes(settings.apiKey)); assert.ok(JSON.parse(content).encryptedKey);
    const restored = new ModelSettings(new ConnectionVault(root, codec));
    assert.deepEqual(await restored.execute({ operation: 'get' }), saved);
    await restored.execute({ operation: 'clear', expectedRevision: saved.revision });
    assert.equal((await restored.execute({ operation: 'get' }) as ModelSettingsState).hasKey, false);
    await assert.rejects(readFile(path), { code: 'ENOENT' }); await service.dispose(); await restored.dispose();
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('unavailable encryption permits session use but refuses persistence, and corrupt encrypted settings recover safely', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dreamedge-model-settings-'));
  try {
    const service = new ModelSettings(new ConnectionVault(root, { supported: false, available: () => false, encrypt: () => { throw new Error('must not encrypt'); }, decrypt: () => { throw new Error('must not decrypt'); } }));
    await assert.rejects(service.execute(settings), /仅本次运行/);
    const saved = await service.execute({ ...settings, persist: false }) as ModelSettingsState;
    assert.equal(saved.persisted, false); assert.equal(saved.hasKey, true);
    await assert.rejects(readFile(join(root, 'model-connection/settings.json')), { code: 'ENOENT' });
    await writeFile(join(root, 'model-connection/settings.json'), '{"encryptedKey":"fixture-private-key"}');
    const restored = new ModelSettings(new ConnectionVault(root, encryption()));
    const status = await restored.execute({ operation: 'get' }) as ModelSettingsState;
    assert.equal(status.hasKey, false); assert.ok(status.warning); assert.ok(!JSON.stringify(status).includes(settings.apiKey));
    await service.dispose(); await restored.dispose();
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('model settings prevent stale writes and require a new key when the service address changes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dreamedge-model-settings-'));
  try {
    const service = new ModelSettings(new ConnectionVault(root, encryption()));
    const first = await service.execute(settings) as ModelSettingsState;
    await assert.rejects(service.execute({ ...settings, model: 'stale' }), /另一个窗口/);
    await assert.rejects(service.execute({ operation: 'test', expectedRevision: 0 }), /另一个窗口/);
    await assert.rejects(service.execute({ ...settings, expectedRevision: first.revision, baseUrl: 'https://other.example/v1', apiKey: '' }), /重新填写/);
    const next = await service.execute({ ...settings, expectedRevision: first.revision, model: 'another-model', apiKey: '' }) as ModelSettingsState;
    assert.equal(next.model, 'another-model'); assert.equal(next.hasKey, true); await service.dispose();
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('connection test sends no project source and rejects raw upstream error disclosure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dreamedge-model-settings-')); let fail = false;
  try {
    const transport: typeof fetch = async (_url, options) => {
      const body = JSON.parse(String(options!.body)); assert.equal(body.text.format.name, 'dreamedge_connection');
      assert.equal(body.store, false); assert.ok(!JSON.stringify(body).includes(settings.apiKey)); assert.ok(!JSON.stringify(body).includes('src/'));
      if (fail) return new Response(settings.apiKey, { status: 401 });
      return Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '{"ok":true}' }] }] });
    };
    const service = new ModelSettings(new ConnectionVault(root, encryption()), {}, () => {}, transport);
    const state = await service.execute(settings) as ModelSettingsState;
    assert.equal((await service.execute({ operation: 'test', expectedRevision: state.revision }) as { available: boolean }).available, true);
    fail = true; const result = await service.execute({ operation: 'test', expectedRevision: state.revision });
    assert.ok(!JSON.stringify(result).includes(settings.apiKey)); assert.match(JSON.stringify(result), /401/); await service.dispose();
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('in-flight requests keep their initial connection while new requests use the newly saved settings', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dreamedge-model-settings-')); const answer = deferred<Response>(); const calls: { url: string; key: string | null }[] = [];
  try {
    const transport: typeof fetch = async (url, options) => { calls.push({ url: String(url), key: new Headers(options!.headers).get('Authorization') }); return calls.length === 1 ? answer.promise : response(); };
    const service = new ModelSettings(new ConnectionVault(root, encryption()), {}, () => {}, transport);
    const state = await service.execute(settings) as ModelSettingsState;
    const old = service.generate(input, new AbortController().signal);
    while (!calls.length) await new Promise(resolve => setTimeout(resolve, 1));
    await service.execute({ ...settings, apiKey: 'fixture-other-key', baseUrl: 'https://other.example/v1', expectedRevision: state.revision });
    answer.resolve(response()); await old; await service.generate(input, new AbortController().signal);
    assert.deepEqual(calls, [{ url: 'https://model.example/v1/responses', key: 'Bearer fixture-private-key' }, { url: 'https://other.example/v1/responses', key: 'Bearer fixture-other-key' }]);
    await assert.rejects(service.assertSafeInput({ ...input, prompt: 'fixture-other-key' }), /凭据/); await service.dispose();
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('clearing settings stops active tests even when the transport ignores abort', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dreamedge-model-settings-'));
  try {
    const service = new ModelSettings(new ConnectionVault(root, encryption()), {}, () => {}, async () => new Promise(() => {}));
    const state = await service.execute(settings) as ModelSettingsState;
    const waiting = service.execute({ operation: 'test', expectedRevision: state.revision });
    await new Promise(resolve => setTimeout(resolve, 10)); await service.execute({ operation: 'clear', expectedRevision: state.revision });
    const result = await waiting as { available: boolean; detail: string };
    assert.equal(result.available, false); assert.match(result.detail, /已清除/); await service.dispose();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('model metadata and echoed model replies cannot expose the configured key', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dreamedge-model-settings-'));
  try {
    const service = new ModelSettings(new ConnectionVault(root, encryption()), {}, () => {}, async () => Response.json({ status: 'completed',
      output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ summary: settings.apiKey, files: [] }) }] }] }));
    await assert.rejects(service.execute({ ...settings, model: settings.apiKey }), /不能包含/);
    await assert.rejects(service.execute({ ...settings, baseUrl: 'https://model.example/' + settings.apiKey }), /不能包含/);
    await service.execute(settings);
    await assert.rejects(service.generate(input, new AbortController().signal), /回复包含连接凭据/); await service.dispose();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('reading model metadata does not initialize or query the system encryptor', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dreamedge-model-settings-')); let checked = 0;
  const codec = encryption();
  const service = new ModelSettings(new ConnectionVault(root, { ...codec, available: async () => { checked++; return true; } }));
  try {
    await service.ready;
    const state = await service.execute({ operation: 'get' }) as ModelSettingsState;
    assert.equal(state.secureStorageSupported, true); assert.equal(checked, 0);
    await service.execute({ ...settings, persist: false }); assert.equal(checked, 0);
    await service.execute({ ...settings, expectedRevision: 1, persist: true }); assert.equal(checked, 1);
  } finally { await service.dispose(); await rm(root, { recursive: true, force: true }); }
});
