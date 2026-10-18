import assert from 'node:assert/strict';
import test from 'node:test';
import { PiRuntime } from '../src/index.js';
import { chatReply, connection, modelServer } from './helpers/server.js';
import { toolConversation } from './helpers/tool-storage.js';

test('native Pi HTTP adapter resumes a saved tool-result tail with original reasoning metadata', async t => {
  const server = await modelServer(response => chatReply(response)); t.after(() => server.close());
  const data = toolConversation();
  const runtime = new PiRuntime(connection(server.baseUrl, { thinkingLevel: 'high' }), async () => 'fixture-key');
  const result = await runtime.start({ sessionId: 's', runId: 'resume', continuation: true,
    messages: [{ role: 'user', content: data.messages[0]!.content, timestamp: 100 },
      ...data.runs[0]!.transcript.slice(0, 2).map(entry => entry.message)] }).done;
  assert.equal(result.status, 'completed'); assert.equal(server.requests.length, 1);
  const body = server.requests[0]!.body;
  const messages = body.messages as { role: string; content: string; reasoning_content?: string;
    tool_call_id?: string; tool_calls?: { id: string }[] }[];
  assert.deepEqual(messages.map(message => message.role), ['user', 'assistant', 'tool']);
  assert.equal(messages[1]!.reasoning_content, 'native reasoning');
  assert.equal(messages[1]!.tool_calls![0]!.id, messages[2]!.tool_call_id);
  assert.equal(messages[2]!.content, 'value 3');
  assert.equal(body.reasoning_effort, 'high'); assert.deepEqual(body.tools ?? [], []);
});
