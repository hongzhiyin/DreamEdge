import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { ProjectDefinition, WorkspaceProject } from '../../shared/contracts';
import { directory, hash } from '../workspace/paths';
import { readSourceTree, equalHashes, treeHashes } from '../workspace/source-tree';
import { BuildStore, buildRoot } from '../build/store';
import { currentVersionState } from './current';
import { commitTransaction, type SaveHook } from './transaction';

export async function applyState(project: WorkspaceProject, profile: string, files: Record<string, string>, definition: ProjectDefinition,
  expectedStateHash: string, signal: AbortSignal, hook?: SaveHook): Promise<void> {
  const current = await currentVersionState(project);
  if (current.stateHash !== expectedStateHash) throw new Error('工程源码已变化，拒绝覆盖当前修改。');
  if (definition.id !== current.definition.id || definition.appId !== current.definition.appId) throw new Error('目标内容不属于当前工程。');
  await commitTransaction(project, profile, { schemaVersion: 1, operationId: randomUUID(), ownerPid: process.pid,
    root: project.rootDirectory, profile: await directory(profile), phase: 'prepared', beforeDefinition: current.raw,
    afterDefinition: JSON.stringify(definition, null, 2), beforeHashes: current.hashes, afterHashes: treeHashes(files) }, files, signal, hook);
}
export async function applyBuild(project: WorkspaceProject, profile: string, buildId: string, signal: AbortSignal, hook?: SaveHook): Promise<void> {
  const store = new BuildStore(); const build = await store.load(project, buildId); const current = await currentVersionState(project);
  if (build.status !== 'succeeded') throw new Error('构建未成功，工程源码保持原样。');
  if (build.definitionHash !== current.definitionHash || !equalHashes(build.sourceHashes, current.hashes)) throw new Error('构建已过期，拒绝覆盖当前源码。');
  await store.verify(project, build);
  const candidate = await readSourceTree(join(buildRoot(project, build.id), 'source')); const definition = await store.candidateDefinition(project, build);
  const base = (value: ProjectDefinition) => { const { dependencies: _deps, dependencyLock: _lock, ...rest } = value; return rest; };
  if (JSON.stringify(base(definition)) !== JSON.stringify(base(current.definition))) throw new Error('构建不能改变工程身份或无关描述。');
  await applyState(project, profile, candidate.files, { ...definition, savedAt: new Date().toISOString() }, current.stateHash, signal, hook);
}
