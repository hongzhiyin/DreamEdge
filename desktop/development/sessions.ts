import { mkdir, readdir, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { DevelopmentSession, DevelopmentSessionSummary, DevelopmentTurn, ProjectContext, WorkspaceProject } from '../../shared/contracts';
import { ensureDirectory, hash, readText, relativeParts, TEXT_LIMIT, writeText } from '../workspace/paths';
import { validateEvents } from './timeline';
import { dependencies } from '../dependencies/policy';
import { CONTEXT_FILES, PROPOSAL_LIMIT, shortText } from './context';

export function identifier(input: unknown): string {
  if (typeof input !== 'string' || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(input)) throw new Error('会话或轮次身份无效。');
  return input;
}
function timestamp(value: unknown): boolean { return typeof value === 'string' && Number.isFinite(Date.parse(value)); }
function validateTurn(value: DevelopmentTurn, id: string): DevelopmentTurn {
  if (!value || value.id !== id || !['running', 'completed', 'failed', 'cancelled', 'interrupted'].includes(value.status)
      || !timestamp(value.startedAt) || (value.finishedAt !== null && !timestamp(value.finishedAt))
      || (value.summary !== null && typeof value.summary !== 'string') || (value.error !== null && typeof value.error !== 'string')
      || !Array.isArray(value.context) || value.context.length > CONTEXT_FILES || !Array.isArray(value.changes) || value.changes.length > 20) {
    throw new Error('会话轮次记录无效。');
  }
  validateEvents(value.events);
  shortText(value.prompt, '会话请求', 8192);
  if (value.phase !== undefined && !['thinking', 'building', 'applying', 'complete'].includes(value.phase)) throw new Error('会话阶段无效。');
  if (value.activity !== undefined && (!Array.isArray(value.activity) || value.activity.length > 48 || value.activity.some(event =>
    !event || typeof event.id !== 'string' || event.id.length > 160 || !['list_files', 'read_file', 'search_files', 'resolve_dependency', 'set_dependencies'].includes(event.tool)
    || !['running', 'completed', 'failed', 'cancelled'].includes(event.status) || typeof event.detail !== 'string' || event.detail.length > 200))) throw new Error('Agent 活动记录无效。');
  if (value.dependencies !== undefined) dependencies(value.dependencies);
  for (const file of value.context) {
    relativeParts(file.path);
    if (typeof file.hash !== 'string' || !/^[a-f0-9]{64}$/.test(file.hash)) throw new Error('上下文记录无效。');
  }
  let bytes = 0;
  for (const change of value.changes) {
    relativeParts(change.path);
    if ((change.content !== null && (typeof change.content !== 'string' || change.content.includes('\0')))
        || (change.expectedHash !== null && (typeof change.expectedHash !== 'string' || !/^[a-f0-9]{64}$/.test(change.expectedHash)))) throw new Error('候选变更记录无效。');
    if (change.content === null && change.expectedHash === null) throw new Error('删除记录缺少原始源码哈希。');
    bytes += Buffer.byteLength(change.content ?? '');
  }
  if (bytes > PROPOSAL_LIMIT) throw new Error('候选变更记录过大。');
  return value;
}
export class SessionStore {
  async list(project: WorkspaceProject): Promise<string[]> {
    const entries = await readdir(project.sessionsDirectory, { withFileTypes: true });
    const ids = entries.filter(entry => !entry.name.startsWith('.')).map(entry => {
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('会话目录无效。');
      return identifier(entry.name);
    });
    if (ids.length > 100) throw new Error('当前阶段每个工程最多支持 100 个会话。');
    return ids.sort();
  }
  async create(project: WorkspaceProject, title: unknown): Promise<DevelopmentSession> {
    if ((await this.list(project)).length >= 100) throw new Error('当前阶段每个工程最多支持 100 个会话。');
    const now = new Date().toISOString();
    const session: DevelopmentSession = { schemaVersion: 1, id: randomUUID(), projectId: project.definition.id,
      title: shortText(title, '会话名称', 160), createdAt: now, updatedAt: now, turns: [] };
    await this.save(project, session);
    return session;
  }
  async load(project: WorkspaceProject, input: unknown): Promise<DevelopmentSession> {
    const id = identifier(input);
    const value = await this.metadata(project, id);
    const turns: DevelopmentTurn[] = [];
    for (const turnId of value.turnIds) {
      identifier(turnId);
      turns.push(validateTurn(JSON.parse(await readText(project.sessionsDirectory, `${id}/${turnId}/turn.json`)), turnId));
    }
    return { schemaVersion: 1, id, projectId: value.projectId, title: value.title,
      createdAt: value.createdAt, updatedAt: value.updatedAt, turns };
  }
  private async metadata(project: WorkspaceProject, id: string) {
    const value = JSON.parse(await readText(project.sessionsDirectory, `${id}/session.json`));
    if (!value || value.schemaVersion !== 1 || value.id !== id || value.projectId !== project.definition.id
        || !timestamp(value.createdAt) || !timestamp(value.updatedAt) || !Array.isArray(value.turnIds)
        || value.turnIds.length > 16 || new Set(value.turnIds).size !== value.turnIds.length) throw new Error('会话记录无效或不属于当前工程。');
    shortText(value.title, '会话名称', 160);
    return value;
  }
  async summaries(project: WorkspaceProject): Promise<DevelopmentSessionSummary[]> {
    const result: DevelopmentSessionSummary[] = [];
    for (const id of await this.list(project)) {
      const value = await this.metadata(project, id);
      result.push({ id, title: value.title, updatedAt: value.updatedAt, turnCount: value.turnIds.length });
    }
    return result;
  }
  async save(project: WorkspaceProject, session: DevelopmentSession): Promise<void> {
    const root = await ensureDirectory(project.sessionsDirectory, identifier(session.id));
    for (const turn of session.turns) {
      validateTurn(turn, identifier(turn.id));
      await ensureDirectory(root, turn.id);
      const content = JSON.stringify(turn);
      if (Buffer.byteLength(content) > TEXT_LIMIT) throw new Error('会话轮次记录过大。');
      await writeText(root, `${turn.id}/turn.json`, content);
    }
    const { turns, ...metadata } = session;
    await writeText(root, 'session.json', JSON.stringify({ ...metadata, turnIds: turns.map(turn => turn.id) }));
  }
  async saveContext(project: WorkspaceProject, sessionId: string, turnId: string, context: ProjectContext): Promise<void> {
    const root = await ensureDirectory(project.sessionsDirectory, `${identifier(sessionId)}/${identifier(turnId)}`);
    await writeText(root, 'request-context.json', JSON.stringify(context));
  }
  async context(project: WorkspaceProject, sessionId: string, turn: DevelopmentTurn): Promise<ProjectContext> {
    let value: ProjectContext;
    try { value = JSON.parse(await readText(project.sessionsDirectory, `${identifier(sessionId)}/${identifier(turn.id)}/request-context.json`)); }
    catch { throw new Error('候选缺少有效的上下文快照，请重新生成。'); }
    if (!value || value.definition?.id !== project.definition.id || !Array.isArray(value.files) || value.files.length !== turn.context.length
      || value.files.length > CONTEXT_FILES || new Set(value.files.map(file => file.path)).size !== value.files.length) throw new Error('候选上下文快照无效。');
    let bytes = 0;
    for (const file of value.files) {
      relativeParts(file.path);
      if (typeof file.content !== 'string' || file.content.includes('\0') || hash(file.content) !== file.hash
        || !turn.context.some(item => item.path === file.path && item.hash === file.hash)) throw new Error('候选上下文快照已变化。');
      bytes += Buffer.byteLength(file.content);
    }
    if (bytes > PROPOSAL_LIMIT) throw new Error('候选上下文快照过大。');
    return value;
  }
  async stage(project: WorkspaceProject, sessionId: string, turn: DevelopmentTurn): Promise<void> {
    const root = await ensureDirectory(project.sessionsDirectory, `${identifier(sessionId)}/${identifier(turn.id)}`);
    const temporary = `.${randomUUID()}`;
    await mkdir(join(root, temporary));
    try {
      for (const change of turn.changes) if (change.content !== null) await writeText(root, `${temporary}/${change.path}`, change.content);
      await rename(join(root, temporary), join(root, 'candidate'));
    } finally { await rm(join(root, temporary), { recursive: true, force: true }); }
  }
}
