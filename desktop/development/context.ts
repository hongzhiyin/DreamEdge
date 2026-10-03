import type { CandidateFile, ModelProposal, ProjectContext, ProjectDefinition, WorkspaceProject } from '../../shared/contracts';
import { dependencies } from '../dependencies/policy';
import { hash, listSource, readText, relativeParts } from '../workspace/paths';

export const CONTEXT_LIMIT = 128 * 1024;
export const CONTEXT_FILES = 64;
export const PROPOSAL_LIMIT = 128 * 1024;
export function modelDefinition(definition: ProjectDefinition): ProjectDefinition {
  const { schemaVersion, id, name, appId, version, source, dependencies, build, savedAt } = definition;
  return structuredClone({ schemaVersion, id, name, appId, version, source, dependencies,
    build: { kind: build.kind, entry: build.entry }, savedAt });
}
export function shortText(value: unknown, label: string, limit: number): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || Buffer.byteLength(value) > limit) {
    throw new Error(`${label}为空或超过大小限制。`);
  }
  return value.trim();
}
export async function collectContext(project: WorkspaceProject, paths: unknown): Promise<ProjectContext> {
  if (!Array.isArray(paths) || paths.length > CONTEXT_FILES || new Set(paths).size !== paths.length) {
    throw new Error('上下文文件不能重复或超过 64 个。');
  }
  const files = [];
  let bytes = 0;
  for (const path of paths) {
    relativeParts(path);
    const content = await readText(project.sourceDirectory, path);
    bytes += Buffer.byteLength(content);
    if (bytes > CONTEXT_LIMIT) throw new Error('工程上下文不能超过 128 KB。');
    files.push({ path, content, hash: hash(content) });
  }
  return { definition: modelDefinition(project.definition), files };
}
export async function validateProposal(project: WorkspaceProject, context: ProjectContext, input: unknown): Promise<{ summary: string; changes: CandidateFile[]; dependencies?: Record<string, string> }> {
  const proposal = input as ModelProposal;
  if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal)
      || !Array.isArray(proposal.files) || proposal.files.length > 20) throw new Error('模型返回的变更格式无效。');
  const declared = proposal.dependencies === undefined ? undefined : dependencies(proposal.dependencies);
  const changedDependencies = declared && JSON.stringify(declared) !== JSON.stringify(dependencies(context.definition.dependencies)) ? declared : undefined;
  const summary = shortText(proposal.summary, '模型说明', 4096);
  if (JSON.stringify(modelDefinition(project.definition)) !== JSON.stringify(context.definition)) throw new Error('工程描述已变化，请重新发送请求。');
  const existing = new Set(await listSource(project.sourceDirectory));
  const selected = new Map(context.files.map(file => [file.path, file]));
  // A result based on outdated context is never advertised as a valid candidate.
  for (const file of context.files) {
    if (hash(await readText(project.sourceDirectory, file.path)) !== file.hash) throw new Error('上下文源码已发生变化，请重新发送请求。');
  }
  const seen = new Set<string>();
  const changes: CandidateFile[] = [];
  let bytes = 0;
  for (const file of proposal.files) {
    if (!file || typeof file !== 'object') throw new Error('模型文件格式无效。');
    relativeParts(file.path);
    if (seen.has(file.path)) throw new Error('模型返回了重复文件。');
    seen.add(file.path);
    if (file.content !== null && (typeof file.content !== 'string' || file.content.includes('\0'))) throw new Error('模型文件必须是 UTF-8 文本。');
    bytes += Buffer.byteLength(file.content ?? '');
    if (bytes > PROPOSAL_LIMIT) throw new Error('候选变更不能超过 128 KB。');
    const original = selected.get(file.path);
    if (file.content === null && (!original || !existing.has(file.path))) throw new Error('只能删除已经读取的现有源码文件。');
    if (!original && existing.has(file.path)) throw new Error('模型不能修改未提供上下文的现有文件。');
    changes.push({ path: file.path, content: file.content, expectedHash: original?.hash ?? null });
  }
  const names = [...seen];
  if (names.some(path => names.some(other => other !== path && other.startsWith(path + '/')))
      || names.some(path => [...existing].some(other => other !== path && (path.startsWith(other + '/') || other.startsWith(path + '/'))))) {
    throw new Error('候选文件路径与其他文件冲突。');
  }
  return { summary, changes, dependencies: changedDependencies };
}
