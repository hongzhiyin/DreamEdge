import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { request } from 'node:http';
import { startWebHost, type WebHostOptions } from '../web/server.js';
import { ChatHub } from '../src/chat/hub.js';
import { conversationFixture, startPending } from './helpers/conversation.js';
import { WebAuth } from '../web/auth.js';

async function fixture(extra: Partial<Pick<WebHostOptions, 'extensions'>> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'dreamedge-web-'));
  await writeFile(join(directory, 'index.html'), '<html><head><meta http-equiv="Content-Security-Policy" content="connect-src none"></head><body>Existing renderer</body></html>');
  const core = conversationFixture(), hub = new ChatHub(core.service, core.config, 32, 1);
  const host = await startWebHost({ hub, rendererDirectory: directory, ...extra });
  const post = (path: string, body: unknown, extra: Record<string, string> = {}) => fetch(host.url + path,
    { method: 'POST', headers: { Origin: host.url, 'Content-Type': 'application/json', ...extra }, body: JSON.stringify(body) });
  async function pair() {
    const result = await post('/api/pair', { code: host.issuePairingCode().code }); assert.equal(result.status, 200);
    const cookie = result.headers.get('set-cookie')!; assert.match(cookie, /HttpOnly; SameSite=Strict/);
    const session = await result.json() as { csrf: string };
    return { Cookie: cookie, 'x-dreamedge-csrf': session.csrf };
  }
  return { ...core, host, hub, directory, post, pair, close: async () => {
    await host.close(); hub.dispose(); await core.service.dispose(); await rm(directory, { recursive: true, force: true });
  } };
}

test('web pairing rejects foreign origins, replay, bad CSRF and unsupported extension; reuses renderer', async () => {
  const f = await fixture(); try {
    assert.equal((await fetch(f.host.url + '/api/session')).status, 401);
    assert.equal((await f.post('/api/pair', { code: 'x' }, { Origin: 'https://untrusted.example' })).status, 403);
    const code = f.host.issuePairingCode().code;
    assert.equal((await f.post('/api/pair', { code })).status, 200);
    assert.equal((await f.post('/api/pair', { code })).status, 403);
    const auth = await f.pair(), clientId = randomUUID();
    assert.equal((await fetch(f.host.url + '/api/session', { headers: { Cookie: auth.Cookie } })).status, 403);
    assert.equal((await fetch(f.host.url + '/api/events?clientId=' + clientId, { headers: { Cookie: auth.Cookie } })).status, 403);
    assert.equal((await f.post('/api/chat', { clientId, command: { type: 'create' } }, { Cookie: auth.Cookie })).status, 403);
    const badHost = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(f.host.url + '/api/session', { headers: { ...auth, Host: 'attacker.example' } }, res => {
        res.resume(); resolve(res.statusCode);
      }); req.on('error', reject); req.end();
    }); assert.equal(badHost, 403);
    assert.equal((await f.post('/api/extension/shell', { clientId, command: {} }, auth)).status, 404);
    const page = await fetch(f.host.url, { headers: auth }); const html = await page.text();
    assert.match(html, /Existing renderer/); assert.match(html, /web-bridge.js/); assert.doesNotMatch(html, /http-equiv/);
    assert.match(page.headers.get('content-security-policy')!, /connect-src 'self'/);
    const bridge = await fetch(f.host.url + '/web-bridge.js', { headers: auth }).then(r => r.text());
    assert.match(bridge, /getReader/); assert.doesNotMatch(bridge, /ipcRenderer|apiKey|credentials\.local/);
    f.host.revokeAll(); assert.equal((await fetch(f.host.url + '/api/session', { headers: auth })).status, 401);
  } finally { await f.close(); }
});

test('web chat uses the existing service and can stream, stop, reconnect and read saved conversation', async () => {
  const f = await fixture(); try {
    const auth = await f.pair(), clientId = randomUUID();
    const call = async (command: unknown) => {
      const response = await f.post('/api/chat', { clientId, command }, auth);
      const reply = await response.json() as { ok: boolean; data: any }; assert.equal(reply.ok, true); return reply.data;
    };
    const session = await call({ type: 'create' }); await call({ type: 'watch', sessionId: session.sessionId });
    const abort = new AbortController();
    const stream = await fetch(f.host.url + '/api/events?clientId=' + clientId, { headers: auth, signal: abort.signal });
    const reader = stream.body!.getReader(); await reader.read();
    const ack = await call({ type: 'send', input: { sessionId: session.sessionId, clientMessageId: randomUUID(), text: 'web fixture' } });
    await startPending(); assert.equal(f.calls.length, 1);
    await f.calls[0]!.emit(1, 'partial web reply');
    let received = ''; while (!received.includes('partial web reply')) received += new TextDecoder().decode((await reader.read()).value);
    await call({ type: 'stop', sessionId: session.sessionId, runId: ack.runId }); assert.equal(f.calls[0]!.cancelCount, 1);
    f.calls[0]!.finish('cancelled', 'partial web reply'); await startPending();
    abort.abort(); await reader.cancel().catch(() => {});
    const catchup = await call({ type: 'watch', sessionId: session.sessionId }); assert.equal(catchup.kind, 'snapshot');
    assert.match(JSON.stringify(catchup), /partial web reply/);
    const bootstrap = await call({ type: 'initialize' }); assert.equal(bootstrap.sessions[0].sessionId, session.sessionId);
  } finally { await f.close(); }
});

test('static assets cannot escape the built renderer via symlinks', async () => {
  const f = await fixture(); const outside = join(tmpdir(), randomUUID() + '.js');
  try {
    await writeFile(outside, 'PRIVATE_TEST_MARKER'); await symlink(outside, join(f.directory, 'leak.js'));
    const response = await fetch(f.host.url + '/leak.js', { headers: await f.pair() });
    assert.equal(response.status, 404); assert.doesNotMatch(await response.text(), /PRIVATE_TEST_MARKER/);
  } finally { await f.close(); await rm(outside, { force: true }); }
});

test('pairing expiry and repeated invalid attempts require a fresh desktop code', () => {
  let now = 100; const auth = new WebAuth(() => now); const expired = auth.issuePairingCode();
  now = expired.expiresAt; assert.equal(auth.pair(expired.code), undefined);
  const limited = auth.issuePairingCode(); for (let i = 0; i < 20; i++) assert.equal(auth.pair('wrong'), undefined);
  assert.equal(auth.pair(limited.code), undefined); assert.ok(auth.pair(auth.issuePairingCode().code));
});


test('registered reading extension receives authenticated client requests only', async () => {
  const seen: unknown[] = [];
  const f = await fixture({ extensions: { reading: (command, clientId) => {
    seen.push({ command, clientId }); return { ok: true, data: { bound: true } };
  } } });
  try {
    const clientId = randomUUID(), body = { clientId, command: { type: 'bind', sessionId: 'explicit-chat' } };
    assert.equal((await f.post('/api/extension/reading', body)).status, 401);
    const auth = await f.pair();
    assert.equal((await f.post('/api/extension/reading', body, { Cookie: auth.Cookie })).status, 403);
    assert.equal(seen.length, 0);
    const response = await f.post('/api/extension/reading', body, auth);
    assert.deepEqual(await response.json(), { ok: true, data: { bound: true } }); assert.deepEqual(seen, [body]);
  } finally { await f.close(); }
});

test('embedded handoff scopes history, commands, approvals and extensions even with a full-access cookie', async () => {
  const f = await fixture({ extensions: { mcp: async () => ({ ok: true, data: 'private-settings' }) } });
  try {
    const own = f.create(), other = f.create(), pair = await f.pair();
    const handoff = f.host.issueHandoff(own);
    assert.equal((await fetch(new URL('/embedded', f.host.url))).status, 200);
    const result = await f.post('/api/handoff', { ticket: new URL(handoff.url).hash.slice(1) });
    const { token } = await result.json() as { token: string };
    const headers = { ...pair, 'x-dreamedge-handoff': token, 'x-dreamedge-csrf': token };
    const clientId = randomUUID();
    const call = async (command: unknown) => f.post('/api/chat', { clientId, command }, headers).then(r => r.json()) as Promise<any>;
    const bootstrap = await call({ type: 'initialize' });
    assert.deepEqual(bootstrap.data.sessions.map((s: any) => s.sessionId), [own]);
    assert.equal((await call({ type: 'watch', sessionId: own })).ok, true);
    for (const command of [{ type: 'watch', sessionId: other }, { type: 'create' },
      { type: 'send', input: { sessionId: other, clientMessageId: 'x', text: 'attack' } },
      { type: 'stop', sessionId: other, runId: 'x' }, { type: 'retry', sessionId: other, runId: 'x' },
      { type: 'resumeBatch', reference: { sessionId: other, sourceRunId: 'r', approvalId: 'a', digest: 'd' } },
      { type: 'approval', decision: { sessionId: other, runId: 'r', turnId: 't', toolCallId: 'c', approvalId: 'a', toolName: 'n', toolVersion: 'v', argsDigest: 'd', decision: 'approve' } }]) {
      assert.equal((await call(command)).ok, false);
    }
    assert.equal((await f.post('/api/extension/mcp', { clientId, command: { type: 'snapshot', sessionId: own } }, headers)).status, 403);
    f.host.revokeSession(own);
    assert.equal((await f.post('/api/chat', { clientId, command: { type: 'initialize' } }, headers)).status, 401);
    assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});
