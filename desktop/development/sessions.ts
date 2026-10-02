import { mkdir, readdir, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { DevelopmentSession, DevelopmentTurn, WorkspaceProject } from '../../shared/contracts';
import { ensureDirectory, readText, relativeParts, TEXT_LIMIT, writeText } from '../workspace/paths';
import { PROPOSAL_LIMIT, shortText } from './context';

export function identifier(input: unknown): string {
  if (typeof input !== 'string' || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(input)) throw new Error('会话或轮次身份无效。');
  return input;
}
function timestamp(value: unknown): boolean { return typeof value === 'string' && Number.isFinite(Date.parse(value)); }
function validateTurn(value: DevelopmentTurn, id: string): DevelopmentTurn {
  if (!value || value.id !== id || !['running', 'completed', 'failed', 'cancelled', 'interrupted'].includes(value.status)
      || !timestamp(value.startedAt) || (value.finishedAt !== null && !timestamp(value.finishedAt))
      || (value.summary !== null && typeof value.summary !== 'string') || (value.error !== null && typeof value.error !== 'string')
      || !Array.isArray(value.context) || value.context.length > 20 || !Array.isArray(value.changes) || value.changes.length > 20) {
    throw new Error('会话轮次记录无效。');
  }
  shortText(value.prompt, '会话请求', 8192);
  for (const file of value.context) {
    relativeParts(file.path);
    if (typeof file.hash !== 'string' || !/^[a-f0-9]{64}$/.test(file.hash)) throw new Error('上下文记录无效。');
  }
  let bytes = 0;
  for (const change of value.changes) {
    relativeParts(change.path);
    if (typeof change.content !== 'string' || change.content.includes('\0')
        || (change.expectedHash !== null && (typeof change.expectedHash !== 'string' || !/^[a-f0-9]{64}$/.test(change.expectedHash)))) throw new Error('候选变更记录无效。');
    bytes += Buffer.byteLength(change.content);
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
    const value = JSON.parse(await readText(project.sessionsDirectory, `${id}/session.json`));
    if (!value || value.schemaVersion !== 1 || value.id !== id || value.projectId !== project.definition.id
        || !timestamp(value.createdAt) || !timestamp(value.updatedAt) || !Array.isArray(value.turnIds)
        || value.turnIds.length > 16 || new Set(value.turnIds).size !== value.turnIds.length) throw new Error('会话记录无效或不属于当前工程。');
    shortText(value.title, '会话名称', 160);
    const turns: DevelopmentTurn[] = [];
    for (const turnId of value.turnIds) {
      identifier(turnId);
      turns.push(validateTurn(JSON.parse(await readText(project.sessionsDirectory, `${id}/${turnId}/turn.json`)), turnId));
    }
    return { schemaVersion: 1, id, projectId: value.projectId, title: value.title,
      createdAt: value.createdAt, updatedAt: value.updatedAt, turns };
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
  async stage(project: WorkspaceProject, sessionId: string, turn: DevelopmentTurn): Promise<void> {
    const root = await ensureDirectory(project.sessionsDirectory, `${identifier(sessionId)}/${identifier(turn.id)}`);
    const temporary = `.${randomUUID()}`;
    await mkdir(join(root, temporary));
    try {
      for (const change of turn.changes) await writeText(root, `${temporary}/${change.path}`, change.content);
      await rename(join(root, temporary), join(root, 'candidate'));
    } finally { await rm(join(root, temporary), { recursive: true, force: true }); }
  }
}
