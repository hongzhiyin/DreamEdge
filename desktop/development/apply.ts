import type { CandidateReference, CandidateBuild, DevelopmentEvent } from '../../shared/contracts';
import { CandidateBuildApi } from '../build/api';
import { WorkspaceApi } from '../workspace/api';
import { applyBuild } from '../changes/apply';
import { ModelFailure } from './model';
import type { GitExecutionPlan } from './git-access';
import { checkedCommit, checkedGitState, checkpointRestore } from './git-write';
import { repositoryState } from '../git/state';
import { currentVersionState } from '../changes/current';
import { readText } from '../workspace/paths';
import { DEFINITION_FILE, validateDefinition } from '../workspace/definition';

export class AutomaticEdits {
  constructor(private readonly workspace: WorkspaceApi, private readonly profile: string, private readonly builds: CandidateBuildApi, private readonly changed: (buildId?: string) => void) {}
  async apply(projectId: string, candidate: CandidateReference, signal: AbortSignal, phase: (value: 'building' | 'applying', buildId?: string) => Promise<void>, event?: (event: DevelopmentEvent) => Promise<void>,
    gitPlan?: GitExecutionPlan, checkpoint?: (id: string) => Promise<void>) {
    await phase('building');
    const report = event ? (record: CandidateBuild) => event({ id: 'build', kind: 'build', label: '构建工程',
      status: record.status === 'running' ? 'running' : record.status === 'succeeded' ? 'completed' : record.status === 'cancelled' ? 'cancelled' : 'failed',
      detail: record.logs.at(-1)?.message.slice(0, 200), output: record.logs.map(log => log.message).join('\n') }) : undefined;
    await event?.({ id: 'build', kind: 'build', label: '构建工程', status: 'running' });
    const build = await this.builds.build({ operation: 'start', projectId, candidate }, signal, report);
    await report?.(build);
    if (build.status !== 'succeeded') throw new ModelFailure(build.logs.filter(log => log.level === 'error').map(log => log.message).join('\n').slice(0, 1800) || '自动构建失败；源码未被修改。');
    signal.throwIfAborted(); await phase('applying', build.id);
    await event?.({ id: 'apply', kind: 'apply', label: '应用修改并刷新', status: 'running' });
    await this.workspace.mutateProject(projectId, async project => {
      if (gitPlan) {
        await checkedGitState(project, gitPlan);
        const saved = await checkpointRestore(project, gitPlan, signal); if (saved) await checkpoint?.(saved);
      }
      await applyBuild(project, this.profile, build.id, signal);
      if (gitPlan) {
        const updated = { ...project, definition: validateDefinition(JSON.parse(await readText(project.rootDirectory, DEFINITION_FILE))) };
        gitPlan.expectedStateHash = (await repositoryState(updated, (await currentVersionState(updated)).stateHash)).stateHash;
      }
    });
    this.changed(build.id); await event?.({ id: 'apply', kind: 'apply', label: '应用修改并刷新', status: 'completed' }).catch(() => {}); return { buildId: build.id };
  }
  commit(projectId: string, message: string, signal = new AbortController().signal, plan?: GitExecutionPlan): Promise<string | null> {
    return this.workspace.withProject(projectId, project => checkedCommit(project, message, signal, plan));
  }
}
