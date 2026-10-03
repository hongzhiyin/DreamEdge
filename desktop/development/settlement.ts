import type { DevelopmentTurn, WorkspaceProject } from '../../shared/contracts';
import { recordEvent, finishEvents } from './timeline';
import { BuildStore } from '../build/store';
import { sourceSnapshot } from '../build/snapshot';
import { equalHashes } from '../workspace/source-tree';

export async function settleInterruptedTurn(project: WorkspaceProject, turn: DevelopmentTurn): Promise<void> {
  let applied = false;
  if (turn.phase === 'applying' && turn.buildId) {
    try {
      const store = new BuildStore(); const build = await store.load(project, turn.buildId); const current = await sourceSnapshot(project);
      const candidate = await store.candidateDefinition(project, build);
      const { savedAt: _candidateTime, ...expected } = candidate;
      const { savedAt: _currentTime, ...actual } = project.definition;
      applied = build.status === 'succeeded' && equalHashes(current.hashes, build.candidateHashes) && JSON.stringify(expected) === JSON.stringify(actual);
    } catch {}
  }
  turn.status = applied ? 'completed' : 'interrupted'; turn.applied = applied; turn.phase = 'complete'; turn.finishedAt = new Date().toISOString();
  turn.error = applied ? null : '上次会话已中断，请核对工程当前源码后重新发送请求。';
  if (applied) turn.warning = '上次修改已经应用，运行反馈已恢复；Git 提交状态请在工程历史中核对。';
  if (applied) recordEvent(turn, { id: 'apply', kind: 'apply', label: '应用修改并刷新', status: 'completed', output: '已核对中断后的源码及工程描述。' });
  finishEvents(turn, 'cancelled');
  for (const event of turn.activity ?? []) if (event.status === 'running') event.status = 'cancelled';
}
