import { randomUUID } from 'node:crypto';
import { readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { ProjectDefinition, ProjectVersion, VersionOperation, WorkspaceProject } from '../../shared/contracts';
import { identifier } from '../development/sessions';
import { shortText } from '../development/context';
import { validateDefinition } from '../workspace/definition';
import { ensureDirectory, hash, readText, writeText } from '../workspace/paths';
import { equalHashes, readSourceTree, treeHashes, validHashes, writeSourceTree } from '../workspace/source-tree';
import { readHistory, type VersionEntry, type VersionHistory } from './history';

export class VersionStore {
  async history(project: WorkspaceProject): Promise<VersionHistory> { return readHistory(project.versionsDirectory, project.definition.id); }
  async snapshot(project: WorkspaceProject, definition: ProjectDefinition, files: Record<string, string>,
    attributes: Pick<ProjectVersion, 'kind' | 'label' | 'buildId' | 'restoredFrom' | 'operationId'>, signal: AbortSignal): Promise<VersionEntry> {
    const id = randomUUID(); const temporary = `.${id}`;
    const root = await ensureDirectory(project.versionsDirectory, temporary);
    try {
      const record: ProjectVersion = { schemaVersion: 1, id, projectId: project.definition.id,
        createdAt: new Date().toISOString(), definition, sourceHashes: treeHashes(files), ...attributes };
      await writeSourceTree(await ensureDirectory(root, 'source'), files, signal);
      const content = JSON.stringify(record);
      await writeText(root, 'snapshot.json', content);
      signal.throwIfAborted();
      await rename(root, join(project.versionsDirectory, id));
      return { id, checksum: hash(content) };
    } finally { await rm(root, { recursive: true, force: true }); }
  }
  async record(project: WorkspaceProject, entry: VersionEntry): Promise<ProjectVersion> {
    identifier(entry.id);
    const content = await readText(project.versionsDirectory, `${entry.id}/snapshot.json`);
    if (hash(content) !== entry.checksum) throw new Error('版本记录已被修改，拒绝恢复。');
    const record = JSON.parse(content) as ProjectVersion;
    if (!record || record.schemaVersion !== 1 || record.id !== entry.id || record.projectId !== project.definition.id
        || !['checkpoint', 'saved', 'restored'].includes(record.kind) || !validHashes(record.sourceHashes)
        || typeof record.createdAt !== 'string' || !Number.isFinite(Date.parse(record.createdAt))) throw new Error('版本快照记录无效。');
    shortText(record.label, '版本名称', 160);
    identifier(record.operationId);
    const definition = validateDefinition(record.definition);
    if (definition.id !== project.definition.id || definition.appId !== project.definition.appId) throw new Error('版本快照身份不属于当前工程。');
    if (record.buildId !== null) identifier(record.buildId);
    if (record.restoredFrom !== null) identifier(record.restoredFrom);
    return record;
  }
  async restoreSource(project: WorkspaceProject, entry: VersionEntry) {
    const record = await this.record(project, entry);
    const tree = await readSourceTree(join(project.versionsDirectory, entry.id, 'source'));
    if (!equalHashes(record.sourceHashes, tree.hashes)) throw new Error('版本源码已被修改，拒绝恢复。');
    return { record, ...tree };
  }
  async saveOperation(project: WorkspaceProject, operation: VersionOperation): Promise<void> {
    const root = await ensureDirectory(project.versionsDirectory, 'operations');
    await writeText(root, `${identifier(operation.id)}.json`, JSON.stringify(operation));
  }
  async createOperation(project: WorkspaceProject, operation: VersionOperation): Promise<void> {
    const root = await ensureDirectory(project.versionsDirectory, 'operations');
    if ((await readdir(root)).length >= 100) throw new Error('当前工程最多记录 100 次版本操作。');
    await this.saveOperation(project, operation);
  }
  async operation(project: WorkspaceProject, id: string): Promise<VersionOperation> {
    identifier(id);
    const operation = JSON.parse(await readText(project.versionsDirectory, `operations/${id}.json`)) as VersionOperation;
    if (!operation || operation.schemaVersion !== 1 || operation.id !== id || operation.projectId !== project.definition.id
        || !['confirm', 'restore'].includes(operation.kind) || !['running', 'completed', 'failed', 'cancelled', 'interrupted'].includes(operation.status)
        || typeof operation.startedAt !== 'string' || !Number.isFinite(Date.parse(operation.startedAt))
        || (operation.finishedAt !== null && !Number.isFinite(Date.parse(operation.finishedAt)))
        || (operation.error !== null && typeof operation.error !== 'string')) throw new Error('版本操作记录无效。');
    if (operation.versionId !== null) identifier(operation.versionId);
    if (operation.checkpointId !== null) identifier(operation.checkpointId);
    return operation;
  }
}
