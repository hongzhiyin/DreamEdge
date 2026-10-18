import type { ConversationSnapshot } from '../conversation/types.js';
import type { ChatView } from './types.js';
import { toolTimeline } from './tool-projection.js';
import type { FileScopeOverview } from '../files/scope-types.js';

/** Public view contains no credential references, configuration paths or native provider payloads. */
export function chatView(snapshot: ConversationSnapshot, fileScope?: FileScopeOverview): ChatView {
  const { session, messages, runs, saveState } = snapshot;
  return {
    sessionId: session.sessionId,
    ...(session.externalTools ? { externalContext: 'mcp-read' as const } : session.toolsDisabled ? { externalContext: 'reference-only' as const } : {}),
    title: messages[0]?.content.split('\n')[0]?.slice(0, 32) || session.title,
    updatedAt: session.updatedAt,
    ...(fileScope ? { fileScope: structuredClone(fileScope) } : {}),
    acceptingCommands: snapshot.acceptingCommands,
    messages: messages.map(question => ({ messageId: question.messageId,
      clientMessageId: question.clientMessageId, text: question.content,
      attempts: runs.filter(run => run.userMessageId === question.messageId).map(run => ({
        runId: run.runId, status: run.status, text: run.text, thinking: run.thinking,
        model: run.modelConfigSnapshot.model,
        ...(run.thinkingLevel ? { thinkingLevel: run.thinkingLevel } : {}),
        ...(run.error ? { error: run.error.message } : {}),
        ...(run.approvals?.length ? { approvals: structuredClone([...run.approvals]) } : {}),
        ...(run.transcript ? { timeline: toolTimeline(run, runs),
          canRetryRead: run.toolsSnapshot?.some(tool => tool.effect === 'read' && tool.approval === 'never') ?? false } : {}),
        retryBlocked: runs.some(attempt => attempt.userMessageId === question.messageId
          && attempt.toolCalls?.some(call => call.status === 'outcome_unknown')),
      })) })),
    ...(snapshot.activeRunId ? { activeRunId: snapshot.activeRunId } : {}),
    saving: { status: saveState.status, ...(saveState.error ? { error: saveState.error.message } : {}) },
  };
}
