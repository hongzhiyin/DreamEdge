import { validateMcpData } from './mcp-validation.js';
import { validateFileSources } from './file-validation.js';
import { assertFileScope } from '../files/scope-validation.js';
import { parseModelConnection } from '../model/config.js';
import { prepareContext } from '../model/context.js';
import { thinkingLevels } from '../model/types.js';
import { SessionStoreError } from './types.js';
import type { StoredConversation } from './types.js';
import { validateToolData } from './tool-validation.js';
import { hasRunData } from '../conversation/run-data.js';

function invalid(): never { throw new SessionStoreError('INVALID_DATA', '会话数据库记录无效。'); }
const text = (value: unknown) => typeof value === 'string' && value.trim().length > 0;
const integer = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0;

export function validateStored(value: unknown): asserts value is StoredConversation {
  try {
    const { session, messages, runs } = value as StoredConversation;
    if (!session || !text(session.sessionId) || !text(session.title) || !text(session.connectionId)
      || !integer(session.version) || !Number.isFinite(session.createdAt) || !Number.isFinite(session.updatedAt)
      || (session.externalTools !== undefined && (session.externalTools !== true || session.toolsDisabled === true))
      || (session.toolsDisabled !== undefined && session.toolsDisabled !== true)
      || (session.systemPrompt !== undefined && typeof session.systemPrompt !== 'string')
      || !Array.isArray(messages) || !Array.isArray(runs)) invalid();
    if (session.fileScope !== undefined) assertFileScope(session.fileScope, session.sessionId);
    const ids = new Set<string>();
    const clients = new Set<string>();
    for (const message of messages) {
      if (!message || message.sessionId !== session.sessionId || !text(message.messageId)
        || !text(message.clientMessageId) || message.role !== 'user' || !text(message.content)
        || !Number.isFinite(message.timestamp) || ids.has(message.messageId) || clients.has(message.clientMessageId)
        || (message.requestedThinkingLevel !== undefined && !thinkingLevels.includes(message.requestedThinkingLevel))) invalid();
      ids.add(message.messageId); clients.add(message.clientMessageId);
    }
    const runIds = new Set<string>();
    for (const run of runs) {
      if (!run || run.sessionId !== session.sessionId || !text(run.runId) || runIds.has(run.runId)
        || !ids.has(run.userMessageId) || !['running', 'cancelling', 'completed', 'cancelled', 'failed', 'interrupted'].includes(run.status)
        || typeof run.text !== 'string' || typeof run.thinking !== 'string' || !integer(run.lastEventSequence)
        || !Number.isFinite(run.createdAt) || (run.finishedAt !== undefined && !Number.isFinite(run.finishedAt))
        || !Array.isArray(run.notices) || run.notices.some(notice => typeof notice !== 'string')) invalid();
      parseModelConnection(run.modelConfigSnapshot);
      validateToolData(run);
      validateMcpData(run);
      if (run.batchRecovery) {
        const ref = run.batchRecovery;
        const source = runs.find(r => r.runId === ref.sourceRunId);
        if (!runIds.has(ref.sourceRunId) || source?.batchRecovery
          || !source?.approvals?.some(a => a.approvalId === ref.approvalId && a.batchPlan?.digest === ref.digest)) invalid();
      }
      if (run.status === 'completed' && !hasRunData(run)) {
        if (!run.nativeMessage || run.nativeMessage.stopReason !== 'stop') invalid();
        prepareContext({ sessionId: session.sessionId, runId: run.runId, messages: [
          run.nativeMessage, { role: 'user', content: 'validate', timestamp: 0 },
        ] });
      }
      runIds.add(run.runId);
    }
    validateFileSources({ session, messages, runs });
    if (session.fileScope?.observations.some(o => !runIds.has(o.source.runId))) invalid();
    if (messages.some(message => !runs.some(run => run.userMessageId === message.messageId))) invalid();
  } catch { invalid(); }
}
