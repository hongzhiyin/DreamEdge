import { directory } from '../workspace/paths';
import { readSourceTree, equalHashes, stateHash } from '../workspace/source-tree';
import { projectVersion } from '../workspace/definition';
import { buildRoot, BuildStore } from '../build/store';
import { join } from 'node:path';
import type { ProjectDefinition, VersionOperation, VersionRequest, WorkspaceProject } from '../../shared/contracts';
import { currentVersionState } from './current';
import { VersionStore } from './store';
import { type SaveJournal } from './journal';
import { commitTransaction, type SaveHook } from './transaction';

export type ChangeRequest = Extract<VersionRequest, { operation: 'confirm' | 'restore' }>;
export interface SavePlan { files: Record<string, string>; definition: ProjectDefinition; expectedStateHash: string; buildId: string | null; restoredFrom: string | null }
export async function planSave(project: WorkspaceProject, request: ChangeRequest): Promise<SavePlan> {
  const current = await currentVersionState(project);
  if (request.operation === 'confirm') {
    const builds = new BuildStore(); const build = await builds.load(project, request.buildId);
    if (build.status !== 'succeeded') throw new Error('只能确认保存成功构建的候选。');
    if (build.definitionHash !== current.definitionHash || !equalHashes(build.sourceHashes, current.hashes)) throw new Error('候选已过期，拒绝覆盖当前源码。');
    await builds.verify(project, build);
    const candidate = await readSourceTree(join(buildRoot(project, build.id), 'source'));
    const definition = await builds.candidateDefinition(project, build);
    const base = (value: ProjectDefinition) => { const { dependencies: _deps, dependencyLock: _lock, ...rest } = value; return rest; };
    if (JSON.stringify(base(definition)) !== JSON.stringify(base(current.definition))) throw new Error('候选不能改变工程身份或无关描述。');
    const parts = current.definition.version.split('.');
    const version = request.version === undefined ? `${parts[0]}.${parts[1]}.${BigInt(parts[2]) + 1n}` : projectVersion(request.version);
    return { files: candidate.files, definition: { ...definition, version, savedAt: new Date().toISOString() },
      expectedStateHash: stateHash(build.definitionHash, build.sourceHashes), buildId: build.id, restoredFrom: null };
  }
  if (request.expectedStateHash !== current.stateHash) throw new Error('恢复前的工程状态已变化，请重新核对版本。');
  const store = new VersionStore(); const history = await store.history(project);
  const entry = history.entries.find(entry => entry.id === request.versionId);
  if (!entry) throw new Error('目标版本不属于当前工程历史。');
  const snapshot = await store.restoreSource(project, entry);
  return { files: snapshot.files, definition: { ...snapshot.record.definition, savedAt: new Date().toISOString() },
    expectedStateHash: request.expectedStateHash, buildId: snapshot.record.buildId, restoredFrom: entry.id };
}
export async function saveVersion(project: WorkspaceProject, dataDirectory: string, operation: VersionOperation,
  plan: SavePlan, label: string, signal: AbortSignal, hook?: SaveHook): Promise<void> {
  const store = new VersionStore(); const current = await currentVersionState(project);
  if (current.stateHash !== plan.expectedStateHash) throw new Error('工程在确认期间已变化，拒绝覆盖。');
  const beforeHistory = await store.history(project);
  if (beforeHistory.entries.length > 98) throw new Error('当前工程最多保留 100 个版本，请先管理版本存储。');
  signal.throwIfAborted();
  const checkpoint = await store.snapshot(project, current.definition, current.files,
    { kind: 'checkpoint', label: '操作前的源码', buildId: null, restoredFrom: null, operationId: operation.id }, signal);
  const next = await store.snapshot(project, plan.definition, plan.files,
    { kind: operation.kind === 'confirm' ? 'saved' : 'restored', label, buildId: plan.buildId, restoredFrom: plan.restoredFrom, operationId: operation.id }, signal);
  operation.checkpointId = checkpoint.id; operation.versionId = next.id;
  await store.saveOperation(project, operation);
  const afterHistory = { ...beforeHistory, head: next.id, entries: [...beforeHistory.entries, checkpoint, next] };
  const journal: SaveJournal = { schemaVersion: 1, operationId: operation.id, ownerPid: process.pid,
    root: project.rootDirectory, profile: await directory(dataDirectory), phase: 'prepared',
    beforeDefinition: current.raw, afterDefinition: JSON.stringify(plan.definition, null, 2),
    beforeHashes: current.hashes, afterHashes: (await store.restoreSource(project, next)).hashes, beforeHistory, afterHistory };
  signal.throwIfAborted();
  await commitTransaction(project, dataDirectory, journal, plan.files, signal, hook);
}
