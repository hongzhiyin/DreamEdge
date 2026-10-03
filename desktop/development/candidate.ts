import type { CandidateInspection, DevelopmentSession, DevelopmentTurn, ProjectContext, WorkspaceProject } from '../../shared/contracts';
import { validateProposal } from './context';

export async function inspectCandidate(project: WorkspaceProject, session: DevelopmentSession, turn: DevelopmentTurn, context: ProjectContext): Promise<CandidateInspection> {
  let stale = false; let reason: string | null = null;
  try { if (!turn.applied) await validateProposal(project, context, { summary: turn.summary, files: turn.changes, dependencies: turn.dependencies }); }
  catch { stale = true; reason = '工程源码或描述已变化，请重新生成候选后构建。'; }
  const files = context.files.reduce((all, file) => all.set(file.path, file.content), new Map<string, string>());
  return { reference: { sessionId: session.id, turnId: turn.id }, summary: turn.summary!, stale, reason,
    dependencies: turn.dependencies === undefined ? undefined : { before: context.definition.dependencies, after: turn.dependencies },
    files: turn.changes.map(change => ({ path: change.path, before: files.get(change.path) ?? null, after: change.content })) };
}
