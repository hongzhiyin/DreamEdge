import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { registryDisk } from './helpers/mcp-registry.js';
import { McpJsonSettings } from '../src/mcp/json-settings.js';
import { mcpConnectionIdentity } from '../src/mcp/config.js';
const source = { mcpServers: { application: { command: '/configured/application', args: ['mcp'] } } };

test('one standard JSON save registers and approves configuration without invoking a process', async t => {
  const f = await registryDisk(t); const settings = new McpJsonSettings(join(f.dir, 'mcp.json'), f.registry);
  settings.save(JSON.stringify(source));
  const state = f.registry.snapshot(); assert.equal(state.servers.length, 1);
  assert.deepEqual(state.servers[0]!.approval?.identity, mcpConnectionIdentity(state.servers[0]!.config));
  assert.deepEqual(JSON.parse(readFileSync(settings.path, 'utf8')), source);
  const revision = state.revision; settings.reload(); assert.equal(f.registry.snapshot().revision, revision);
});

test('editing the JSON reconciles changes and removal atomically; invalid input leaves active config unchanged', async t => {
  const f = await registryDisk(t), path = join(f.dir, 'mcp.json'), settings = new McpJsonSettings(path, f.registry);
  settings.save(JSON.stringify(source)); const before = f.registry.snapshot();
  assert.throws(() => settings.save(JSON.stringify({ mcpServers: { ...source.mcpServers, broken: { command: 'missing-nonexistent-tool-1234' } } })));
  assert.deepEqual(f.registry.snapshot(), before); assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), source);
  writeFileSync(path, JSON.stringify({ mcpServers: { other: { url: 'http://127.0.0.1:9090/mcp' } } })); settings.reload();
  assert.equal(f.registry.snapshot().servers.find(s => s.config.serverId === 'application')!.revoked, true);
  assert.equal(f.registry.snapshot().servers.find(s => s.config.serverId === 'other')!.approval !== undefined, true);
  unlinkSync(path); settings.reload(); assert.ok(f.registry.snapshot().servers.every(s => s.revoked));
});

test('restart does not restore revoked trust unless the user explicitly saves it again', async t => {
  const f = await registryDisk(t), path = join(f.dir, 'mcp.json'), settings = new McpJsonSettings(path, f.registry);
  settings.save(JSON.stringify(source)); f.registry.revoke(mcpConnectionIdentity(f.registry.snapshot().servers[0]!.config));
  new McpJsonSettings(path, f.registry); assert.equal(f.registry.snapshot().servers[0]!.revoked, true);
  settings.save(JSON.stringify(source)); assert.equal(f.registry.snapshot().servers[0]!.revoked, false);
});

test('program names resolve through host PATH; shell expansions remain rejected', async t => {
  const f = await registryDisk(t), settings = new McpJsonSettings(join(f.dir, 'mcp.json'), f.registry,
    { PATH: process.execPath.slice(0, process.execPath.lastIndexOf('/')) });
  settings.save(JSON.stringify({ mcpServers: { app: { command: 'node', args: ['--version'] } } }));
  const entry = f.registry.snapshot().servers[0]!; assert.equal(entry.config.transport.type, 'stdio');
  assert.ok(entry.config.transport.type === 'stdio' && entry.config.transport.command.endsWith('/node'));
  assert.throws(() => settings.save(JSON.stringify({ mcpServers: { app: { command: 'node && shell' } } })));
});

test('malformed external configuration fails closed and remains editable as raw JSON', async t => {
  const f = await registryDisk(t), settings = new McpJsonSettings(join(f.dir, 'mcp.json'), f.registry);
  writeFileSync(settings.path, '{broken'); const view = settings.snapshot();
  assert.ok(view.error); assert.equal(view.text, '{broken'); assert.deepEqual(f.registry.snapshot().servers, []);
  settings.save(JSON.stringify(source)); assert.equal(settings.snapshot().error, undefined);
});

test('saving JSON connects immediately and subsequent conversations use configured services without binding steps', async t => {
  const { lifecycleFixture } = await import('./helpers/mcp-connection.js');
  const { toolLoopFixture } = await import('./helpers/tool-loop.js');
  const { chatReply } = await import('./helpers/server.js');
  const { McpControl } = await import('../src/mcp/control.js');
  const { dirname } = await import('node:path');
  const mcp = await lifecycleFixture(t), chat = await toolLoopFixture(t, response => chatReply(response));
  const settings = new McpJsonSettings(join(dirname(chat.path), 'mcp.json'), mcp.registry);
  const control = new McpControl(mcp.registry, mcp.manager, () => chat.service, () => chat.config, [], settings);
  const view = await control.request({ type: 'saveConfig', sessionId: chat.sessionId, text: JSON.stringify(source) });
  assert.equal(view.servers.find(s => s.config.serverId === 'application')?.connection?.state, 'ready');
  assert.equal(view.binding, undefined);
  const next = chat.service.createSession({ connectionId: chat.config.id }).sessionId;
  assert.equal(control.mode(next), 'external'); assert.equal(control.select(next)[0]!.serverId, 'application');
  assert.ok(mcp.messages.flat().every(m => !('method' in m) || m.method !== 'tools/call'));
});
