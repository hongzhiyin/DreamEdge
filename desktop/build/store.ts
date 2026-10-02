import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { CandidateBuild, ProjectDefinition, WorkspaceProject } from '../../shared/contracts';
import { identifier } from '../development/sessions';
import { validateDefinition } from '../workspace/definition';
import { dependencies } from '../dependencies/policy';
import { directory, ensureDirectory, hash, readText, relativeParts, writeText } from '../workspace/paths';
import type { BuildOutput } from './types';
import { publishOutput } from './output';
import { equalHashes, readSourceTree } from '../workspace/source-tree';

export function previewUrl(id: string): string { return `dreamedge-preview://b${identifier(id).replaceAll('-', '')}/index.html`; }
export function buildRoot(project: WorkspaceProject, id: string): string { return join(project.buildDirectory, identifier(id)); }
function hashes(input: unknown): input is Record<string, string> {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length > 300) return false;
  return Object.entries(input).every(([path, hash]) => {
    relativeParts(path); return typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash);
  });
}
export class BuildStore {
  async create(project: WorkspaceProject, record: CandidateBuild): Promise<string> {
    if ((await readdir(project.buildDirectory)).filter(name => !name.startsWith('.')).length >= 100) throw new Error('当前每个工程最多保留 100 次构建。');
    const root = await ensureDirectory(project.buildDirectory, record.id);
    await this.save(project, record);
    return root;
  }
  async save(project: WorkspaceProject, record: CandidateBuild): Promise<void> {
    await directory(buildRoot(project, record.id));
    await writeText(project.buildDirectory, `${record.id}/record.json`, JSON.stringify(record));
  }
  async load(project: WorkspaceProject, id: string): Promise<CandidateBuild> {
    identifier(id);
    const record = JSON.parse(await readText(project.buildDirectory, `${id}/record.json`)) as CandidateBuild;
    if (!record || record.schemaVersion !== 3 || record.id !== id || record.projectId !== project.definition.id
        || !['running', 'succeeded', 'failed', 'cancelled', 'interrupted'].includes(record.status)
        || !hashes(record.sourceHashes) || !hashes(record.candidateHashes) || !hashes(record.outputHashes)
        || typeof record.definitionHash !== 'string' || !/^[a-f0-9]{64}$/.test(record.definitionHash)
        || !['resolving', 'installing', 'compiling', 'complete'].includes(record.phase)
        || typeof record.candidateDefinitionHash !== 'string' || !/^[a-f0-9]{64}$/.test(record.candidateDefinitionHash)
        || !Array.isArray(record.logs) || record.logs.length > 64
        || record.logs.some(log => !log || !['info', 'warning', 'error'].includes(log.level) || typeof log.message !== 'string' || log.message.length > 2000)
        || typeof record.startedAt !== 'string' || !Number.isFinite(Date.parse(record.startedAt))
        || (record.finishedAt !== null && !Number.isFinite(Date.parse(record.finishedAt)))
        || (record.previewUrl !== null && record.previewUrl !== previewUrl(id))) throw new Error('构建记录无效或不属于当前工程。');
    dependencies(record.dependencies);
    if (record.candidate !== null) { identifier(record.candidate.sessionId); identifier(record.candidate.turnId); }
    if (record.status === 'succeeded' && (!record.previewUrl || !Object.hasOwn(record.outputHashes, 'index.html'))) throw new Error('成功构建缺少预览产物。');
    return record;
  }
  async candidateDefinition(project: WorkspaceProject, record: CandidateBuild): Promise<ProjectDefinition> {
    const content = await readText(buildRoot(project, record.id), 'candidate-definition.json');
    if (hash(content) !== record.candidateDefinitionHash) throw new Error('候选工程描述或依赖锁定已变化，请重新构建。');
    const definition = validateDefinition(JSON.parse(content));
    if (definition.id !== project.definition.id || definition.appId !== project.definition.appId
      || JSON.stringify(dependencies(definition.dependencies)) !== JSON.stringify(dependencies(record.dependencies))) throw new Error('候选工程身份或依赖与构建记录不一致。');
    return definition;
  }
  async verify(project: WorkspaceProject, record: CandidateBuild): Promise<void> {
    await this.candidateDefinition(project, record);
    const candidate = await readSourceTree(join(buildRoot(project, record.id), 'source'));
    if (!equalHashes(candidate.hashes, record.candidateHashes)) throw new Error('候选源码副本已变化，请重新构建。');
    const root = join(buildRoot(project, record.id), 'output');
    for (const [path, expected] of Object.entries(record.outputHashes)) {
      if (hash(await readText(root, path)) !== expected) throw new Error('构建产物已变化，请重新构建候选。');
    }
  }
  async publish(project: WorkspaceProject, id: string, output: BuildOutput): Promise<Record<string, string>> {
    return publishOutput(buildRoot(project, id), output);
  }
}
