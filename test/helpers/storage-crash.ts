import { ConversationService, SqliteSessionStore } from '../../src/index.js';
import type { AgentRuntime } from '../../src/index.js';
import { assistant } from './conversation.js';
import { connection } from './server.js';

const [path, phase] = process.argv.slice(2);
if (!path || !['running', 'cancelling'].includes(phase ?? '')) throw new Error('Invalid crash fixture');
const store = new SqliteSessionStore(path);
const runtime: AgentRuntime = { start(request, observer) {
  if (request.messages.at(-1)?.content === 'first question') {
    return { cancel() {}, done: Promise.resolve({ sessionId: request.sessionId, runId: request.runId,
      status: 'completed', text: 'first answer', message: assistant('first answer'), stopReason: 'stop' }) };
  }
  void observer?.({ sessionId: request.sessionId, runId: request.runId,
    sequence: 1, type: 'delta', channel: 'text', delta: 'Partial' }, new AbortController().signal);
  return { cancel() {}, done: new Promise(() => {}) };
} };
const service = new ConversationService({ store, checkpointMs: 5,
  connection: () => connection('http://127.0.0.1:1'), runtime: () => runtime });
const sessionId = service.createSession({ connectionId: 'fixture' }).sessionId;
await service.send({ sessionId, clientMessageId: 'first', text: 'first question' }).done;
service.send({ sessionId, clientMessageId: 'unfinished', text: 'unfinished question' });
let announced = false;
setInterval(() => {
  const run = store.load()[0]?.runs[1];
  if (!run || run.text !== 'Partial' || announced) return;
  if (phase === 'cancelling' && run.status === 'running') { service.stop(sessionId); return; }
  if (run.status === phase) { announced = true; process.stdout.write('CHECKPOINT_READY\n'); }
}, 5);
