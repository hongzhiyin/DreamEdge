import type { DevelopmentEvent, DevelopmentTurn } from '../../shared/contracts';
import type { AutomaticEdits } from './apply';
import type { ProjectAccess } from './project-access';
import { ModelFailure } from './model';
import { recordEvent } from './timeline';

export async function finishTurnGit(projectId: string, turn: DevelopmentTurn, access: ProjectAccess, edits: AutomaticEdits,
  signal: AbortSignal, event: (event: DevelopmentEvent) => Promise<void>) {
  try {
    await event({ id: 'git-commit', kind: 'commit', label: '提交 Git', status: 'running' });
    turn.commitId = await edits.commit(projectId, access.commitMessage ?? turn.summary!, signal, access.git.plan);
    recordEvent(turn, { id: 'git-commit', kind: 'commit', label: '提交 Git', status: 'completed', output: turn.commitId ?? '没有需要提交的修改' });
    await event(turn.events!.find(event => event.id === 'git-commit')!).catch(() => {});
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Git 提交失败。';
    recordEvent(turn, { id: 'git-commit', kind: 'commit', label: '提交 Git', status: 'failed', output: message });
    if (!turn.applied) throw new ModelFailure(message);
    turn.warning = '修改已应用，但 Git 未提交：' + message;
  }
}
