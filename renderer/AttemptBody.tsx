import type { ChatAttempt, ChatView } from '../src/chat/types.js';
import type { ApprovalDecisionCommand } from '../src/runtime/tool-contracts.js';
import { ModelText } from './ModelText.js';
import { ToolCard } from './ToolCard.js';

export function AttemptBody({ attempt, view, pending, approve }: { attempt: ChatAttempt; view: ChatView; pending: boolean;
  approve(command: ApprovalDecisionCommand): Promise<boolean> }) {
  const enabled = !pending && view.acceptingCommands && view.saving.status === 'saved'
    && view.activeRunId === attempt.runId && attempt.status === 'running';
  if (!attempt.timeline?.length) return <ModelText text={attempt.text} thinking={attempt.thinking} />;
  return <div className="tool-timeline">{attempt.timeline.filter(item => item.kind !== 'tool' || !item.call.approval?.batch || item.call.approval.batchPlan).map(item => item.kind === 'model'
    ? <ModelText key={item.messageId} text={item.text} thinking={item.thinking} />
    : <ToolCard key={item.call.toolCallId} call={item.call} enabled={enabled} approve={approve} sessionId={view.sessionId} canResume={!pending && view.acceptingCommands && view.saving.status === 'saved' && !view.activeRunId} />)}</div>;
}
