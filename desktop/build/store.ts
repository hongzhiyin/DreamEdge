import { randomUUID } from 'node:crypto';
import { readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { CandidateBuild, WorkspaceProject } from '../../shared/contracts';
import { identifier } from '../development/sessions';
import { directory, ensureDirectory, hash, readText, relativeParts, TEXT_LIMIT, writeText } from '../workspace/paths';
import { BuildFailure, type BuildOutput } from './types';
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
    if (!record || record.schemaVersion !== 2 || record.id !== id || record.projectId !== project.definition.id
        || !['running', 'succeeded', 'failed', 'cancelled', 'interrupted'].includes(record.status)
        || !hashes(record.sourceHashes) || !hashes(record.candidateHashes) || !hashes(record.outputHashes)
        || typeof record.definitionHash !== 'string' || !/^[a-f0-9]{64}$/.test(record.definitionHash)
        || !Array.isArray(record.logs) || record.logs.length > 64
        || record.logs.some(log => !log || !['info', 'warning', 'error'].includes(log.level) || typeof log.message !== 'string' || log.message.length > 2000)
        || typeof record.startedAt !== 'string' || !Number.isFinite(Date.parse(record.startedAt))
        || (record.finishedAt !== null && !Number.isFinite(Date.parse(record.finishedAt)))
        || (record.previewUrl !== null && record.previewUrl !== previewUrl(id))) throw new Error('构建记录无效或不属于当前工程。');
    if (record.candidate !== null) { identifier(record.candidate.sessionId); identifier(record.candidate.turnId); }
    if (record.status === 'succeeded' && (!record.previewUrl || !Object.hasOwn(record.outputHashes, 'index.html'))) throw new Error('成功构建缺少预览产物。');
    return record;
  }
  async verify(project: WorkspaceProject, record: CandidateBuild): Promise<void> {
    const candidate = await readSourceTree(join(buildRoot(project, record.id), 'source'));
    if (!equalHashes(candidate.hashes, record.candidateHashes)) throw new Error('候选源码副本已变化，请重新构建。');
    const root = join(buildRoot(project, record.id), 'output');
    for (const [path, expected] of Object.entries(record.outputHashes)) {
      if (hash(await readText(root, path)) !== expected) throw new Error('构建产物已变化，请重新构建候选。');
    }
  }
  async publish(project: WorkspaceProject, id: string, output: BuildOutput): Promise<Record<string, string>> {
    const entries = Object.entries(output.files);
    if (!entries.length || entries.length > 300 || !Object.hasOwn(output.files, 'index.html')) throw new BuildFailure([{ level: 'error', message: '构建产物无效。' }]);
    const checksums: Record<string, string> = Object.create(null);
    let bytes = 0;
    for (const [path, content] of entries) {
      relativeParts(path);
      if (typeof content !== 'string' || Buffer.byteLength(content) > TEXT_LIMIT) throw new Error('单个构建产物不能超过 1 MB。');
      bytes += Buffer.byteLength(content); checksums[path] = hash(content);
    }
    if (bytes > 8 * TEXT_LIMIT) throw new Error('构建产物总量不能超过 8 MB。');
    const root = buildRoot(project, id);
    const temporary = `.${randomUUID()}`;
    const staging = await ensureDirectory(root, temporary);
    try {
      for (const [path, content] of entries) await writeText(staging, path, content);
      await rename(staging, join(root, 'output'));
    } finally { await rm(staging, { recursive: true, force: true }); }
    return checksums;
  }
}
