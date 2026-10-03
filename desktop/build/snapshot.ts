import type { CandidateFile, CandidateReference, WorkspaceProject } from '../../shared/contracts';
import { SessionStore } from '../development/sessions';
import { validateProposal } from '../development/context';
import { hash, relativeParts } from '../workspace/paths';
import { equalHashes, readSourceTree, writeSourceTree } from '../workspace/source-tree';
import type { BuildInput } from './types';

export async function sourceSnapshot(project: WorkspaceProject) {
  return { ...await readSourceTree(project.sourceDirectory), definitionHash: hash(JSON.stringify(project.definition)) };
}
export async function applyCandidate(project: WorkspaceProject, files: Record<string, string>, reference?: CandidateReference): Promise<{
  dependencies?: Record<string, string>; projectChanges: CandidateFile[]; projectContextHashes: Record<string, string>;
}> {
  if (!reference) return { projectChanges: [], projectContextHashes: {} };
  const sessions = new SessionStore();
  const session = await sessions.load(project, reference.sessionId);
  const turn = session.turns.find(turn => turn.id === reference.turnId);
  if (!turn || turn.status !== 'completed' && !(turn.status === 'running' && turn.phase === 'building')) throw new Error('只能构建已生成的模型修改。');
  const originalContext = await sessions.context(project, session.id, turn);
  try { await validateProposal(project, originalContext, { summary: turn.summary, files: turn.changes, dependencies: turn.dependencies }); }
  catch { throw new Error('候选上下文已过期，请重新生成变更。'); }
  const prefix = project.definition.source + '/';
  const context = new Map(turn.context.filter(file => file.path.startsWith(prefix)).map(file => [file.path.slice(prefix.length), file.hash]));
  for (const [path, expected] of context) {
    if (!Object.hasOwn(files, path) || hash(files[path]) !== expected) throw new Error('候选上下文已过期，请重新生成变更。');
  }
  const paths = new Set<string>();
  const sourceChanges = turn.changes.filter(change => change.path.startsWith(prefix)).map(change => ({ ...change, path: change.path.slice(prefix.length) }));
  for (const change of sourceChanges) {
    relativeParts(change.path);
    if (paths.has(change.path)) throw new Error('候选包含重复文件。');
    paths.add(change.path);
    const exists = Object.hasOwn(files, change.path);
    if ((exists ? hash(files[change.path]) : null) !== change.expectedHash
        || (exists && context.get(change.path) !== change.expectedHash)) throw new Error('候选修改与当前源码不匹配。');
  }
  for (const change of sourceChanges) {
    if (change.content === null) delete files[change.path]; else files[change.path] = change.content;
  }
  const names = Object.keys(files);
  if (names.some(path => names.some(other => other !== path && other.startsWith(path + '/')))) throw new Error('候选文件与目录冲突。');
  return { dependencies: turn.dependencies, projectChanges: turn.changes.filter(change => !change.path.startsWith(prefix)),
    projectContextHashes: Object.fromEntries(turn.context.filter(file => !file.path.startsWith(prefix)).map(file => [file.path, file.hash])) };
}
export async function saveSnapshot(root: string, input: BuildInput): Promise<void> {
  await writeSourceTree(root, input.files);
}
export function assertSnapshot(input: BuildInput): void {
  const entries = Object.entries(input.files);
  if (entries.length > 200 || entries.reduce((total, [, content]) => total + Buffer.byteLength(content), 0) > 4 * 1024 * 1024) {
    throw new Error('候选源码最多支持 200 个文件、总量 4 MB。');
  }
}
export async function assertSource(project: WorkspaceProject, hashes: Record<string, string>, definitionHash: string): Promise<void> {
  const current = await sourceSnapshot(project);
  if (current.definitionHash !== definitionHash || !equalHashes(current.hashes, hashes)) {
    throw new Error('源工程已变化，请重新构建候选。');
  }
}
