import { recoverFileScope } from '../files/scope-recovery.js';
import type { StoredConversation } from '../storage/types.js';
import { validateStored } from '../storage/validation.js';
import { touch } from './state.js';
import type { SessionState } from './state.js';
import type { SendMessageInput } from './types.js';
import { recoverToolRun } from './tool-recovery.js';

export function restoreSession(snapshot: StoredConversation, now: () => number, notify: () => void): SessionState {
  validateStored(snapshot);
  const data = structuredClone(snapshot);
  const state: SessionState = { ...data, submissions: new Map(), notify,
    saveState: { status: 'saved', savedVersion: data.session.version } };
  let interrupted = recoverFileScope(state.session.fileScope, now());
  for (const run of state.runs) {
    if (recoverToolRun(run, now())) interrupted = true;
    if (run.status === 'running' || run.status === 'cancelling') {
      run.status = 'interrupted'; run.finishedAt = now(); interrupted = true;
    }
  }
  if (interrupted) touch(state, now);
  for (const question of state.messages) {
    const first = state.runs.find(run => run.userMessageId === question.messageId)!;
    const input: SendMessageInput = { sessionId: question.sessionId,
      clientMessageId: question.clientMessageId, text: question.content,
      ...(question.requestedThinkingLevel === undefined ? {} : { thinkingLevel: question.requestedThinkingLevel }) };
    const handle = Object.freeze({ sessionId: first.sessionId, userMessageId: first.userMessageId,
      runId: first.runId, cancel() {}, done: Promise.resolve(structuredClone(first)) });
    state.submissions.set(question.clientMessageId, { input, handle });
  }
  return state;
}
