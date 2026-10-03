import type { CandidateReference } from '../../shared/contracts';
import { CandidateBuildApi } from '../build/api';
import { WorkspaceApi } from '../workspace/api';
import { applyBuild } from '../changes/apply';
import { commitGit } from '../git/repository';
import { ModelFailure } from './model';

export class AutomaticEdits {
  constructor(private readonly workspace: WorkspaceApi, private readonly profile: string, private readonly builds: CandidateBuildApi, private readonly changed: (buildId?: string) => void) {}
  async apply(projectId: string, candidate: CandidateReference, signal: AbortSignal, phase: (value: 'building' | 'applying', buildId?: string) => Promise<void>) {
    await phase('building');
    const build = await this.builds.build({ operation: 'start', projectId, candidate }, signal);
    if (build.status !== 'succeeded') throw new ModelFailure(build.logs.filter(log => log.level === 'error').map(log => log.message).join('\n').slice(0, 1800) || '自动构建失败；源码未被修改。');
    signal.throwIfAborted(); await phase('applying', build.id);
    await this.workspace.mutateProject(projectId, project => applyBuild(project, this.profile, build.id, signal));
    this.changed(build.id); return { buildId: build.id };
  }
  commit(projectId: string, message: string): Promise<string | null> {
    return this.workspace.withProject(projectId, project => commitGit(project.rootDirectory, message));
  }
}
