import { randomUUID } from 'node:crypto';
import type { DevelopmentEvent, DevelopmentRequest, DevelopmentResult, DevelopmentSession, DevelopmentTurn, ProjectContext, WorkspaceProject } from '../../shared/contracts';
import { WorkspaceApi } from '../workspace/api';
import { collectContext, shortText, validateProposal } from './context';
import { ModelFailure, type ModelProvider } from './model';
import { SessionStore } from './sessions';
import { inspectCandidate } from './candidate';
import { ProjectAccess } from './project-access';
import type { AutomaticEdits } from './apply';
import { recordEvent, finishEvents } from './timeline';
import { settleInterruptedTurn } from './settlement';

interface Job { controller: AbortController; done: Promise<void> }
export class DevelopmentApi {
  private readonly store = new SessionStore();
  private readonly jobs = new Map<string, Job>();
  private closed = false;
  constructor(private readonly workspace: WorkspaceApi, private readonly provider: ModelProvider, private readonly timeoutMs = 300000,
    private readonly edits?: AutomaticEdits) {}
  async execute(input: unknown): Promise<DevelopmentResult> {
    if (this.closed) throw new Error('开发会话服务已关闭。');
    const request = structuredClone(input) as DevelopmentRequest;
    if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('无效的开发请求。');
    if (request.operation === 'connection') return structuredClone(await this.provider.connection());
    if (request.operation === 'send') return this.send(request);
    if (request.operation === 'cancel') return this.cancel(request.projectId, request.sessionId);
    return this.workspace.withProject('projectId' in request ? request.projectId : undefined, async project => {
      switch (request.operation) {
        case 'listSummaries': return this.store.summaries(project);
        case 'create': {
          const title = shortText(request.title, '会话名称', 160);
          await this.provider.assertSafeInput?.({ prompt: title, context: { definition: project.definition, files: [] }, history: [] });
          return structuredClone(await this.store.create(project, title));
        }
        case 'candidate': {
          const session = await this.load(project, request.sessionId);
          const turn = session.turns.find(turn => turn.id === request.turnId);
          if (!turn || turn.status !== 'completed' || !turn.summary) throw new Error('只能查看已完成的候选。');
          return inspectCandidate(project, session, turn, await this.store.context(project, session.id, turn));
        }
        case 'get': return structuredClone(await this.load(project, request.sessionId));
        case 'list': {
          const sessions = [];
          for (const id of await this.store.list(project)) sessions.push(await this.load(project, id));
          return structuredClone(sessions);
        }
        default: throw new Error('不支持的开发操作。');
      }
    });
  }
  private async load(project: WorkspaceProject, id: string): Promise<DevelopmentSession> {
    const session = await this.store.load(project, id);
    let changed = false;
    for (const turn of session.turns) {
      if (turn.status === 'running' && !this.jobs.has(session.id)) {
        await settleInterruptedTurn(project, turn); changed = true;
      }
    }
    if (changed) await this.store.save(project, session);
    return session;
  }
  private async send(request: Extract<DevelopmentRequest, { operation: 'send' }>): Promise<DevelopmentSession> {
    const prompt = shortText(request.prompt, '模型请求', 8192);
    const started = await this.workspace.withProject(request.projectId, async project => {
      if (this.closed) throw new Error('开发会话服务已关闭。');
      const session = await this.load(project, request.sessionId);
      if (this.jobs.has(session.id)) throw new Error('该会话已有运行中的请求。');
      if (session.turns.length >= 16) throw new Error('当前阶段每个会话最多支持 16 轮，请创建新会话。');
      const context = await collectContext(project, request.paths ?? []);
      await this.provider.assertSafeInput?.({ prompt, context, history: session.turns.filter(turn => turn.status === 'completed').slice(-4).map(({ prompt, summary, changes, dependencies }) => ({ prompt, summary, changes, dependencies })) });
      const turn: DevelopmentTurn = { id: randomUUID(), prompt, startedAt: new Date().toISOString(), finishedAt: null,
        status: 'running', phase: 'thinking', applied: false, summary: null, error: null, context: context.files.map(({ path, hash }) => ({ path, hash })), changes: [], activity: [], events: [] };
      if (!session.turns.length && session.title === '新会话') session.title = prompt.slice(0, 40);
      await this.store.saveContext(project, session.id, turn.id, context);
      session.turns.push(turn); session.updatedAt = turn.startedAt;
      await this.store.save(project, session);
      const job: Job = { controller: new AbortController(), done: Promise.resolve() };
      this.jobs.set(session.id, job);
      return { project, session, turn, context, job };
    });
    // Launch outside the workspace queue so get/cancel/switch remain responsive.
    started.job.done = this.run(started.project, started.session, started.turn, started.context, started.job, request.commit === true);
    return structuredClone(started.session);
  }
  private async run(project: WorkspaceProject, session: DevelopmentSession, turn: DevelopmentTurn, context: ProjectContext, job: Job, commit: boolean): Promise<void> {
    const { signal } = job.controller;
    const timer = setTimeout(() => job.controller.abort(new Error('模型请求超时；源码未被修改。')), this.timeoutMs);
    let aborted: (() => void) | undefined;
    try {
      const access = new ProjectAccess(this.workspace, project.definition.id, context, commit);
      const result = await Promise.race([
        this.provider.generate({ prompt: turn.prompt, context, history: session.turns.slice(0, -1)
          .filter(previous => previous.status === 'completed').slice(-4)
          .map(({ prompt, summary, changes, dependencies }) => ({ prompt, summary, changes, dependencies })), commit }, signal, {
            event: event => this.event(project.definition.id, session, turn, event, signal),
            execute: (...args) => access.execute(...args),
            activity: event => this.workspace.withProject(project.definition.id, async current => {
              signal.throwIfAborted();
              const previous = turn.activity!.findIndex(item => item.id === event.id);
              if (previous < 0) turn.activity!.push(event); else turn.activity![previous] = event;
              turn.context = context.files.map(({ path, hash }) => ({ path, hash }));
              await this.store.saveContext(current, session.id, turn.id, context); await this.store.save(current, session);
            }),
          }),
        new Promise<never>((_, reject) => {
          aborted = () => reject(signal.reason); signal.addEventListener('abort', aborted, { once: true });
          if (signal.aborted) aborted();
        }),
      ]);
      await this.workspace.withProject(project.definition.id, async current => {
        signal.throwIfAborted();
        const proposal = await validateProposal(current, context, { ...(result as object), dependencies: access.dependencies ?? (result as { dependencies?: unknown })?.dependencies });
        signal.throwIfAborted();
        turn.context = context.files.map(({ path, hash }) => ({ path, hash }));
        await this.store.saveContext(current, session.id, turn.id, context);
        turn.summary = proposal.summary; turn.changes = proposal.changes; turn.dependencies = proposal.dependencies;
        await this.store.stage(current, session.id, turn);
        signal.throwIfAborted();
        await this.store.save(current, session);
      });
      if (this.edits && (turn.changes.length || turn.dependencies !== undefined)) {
        const applied = await this.edits.apply(project.definition.id, { sessionId: session.id, turnId: turn.id }, signal, async (phase, buildId) => {
          turn.phase = phase; if (buildId) turn.buildId = buildId;
          await this.workspace.withProject(project.definition.id, current => this.store.save(current, session));
        }, event => this.event(project.definition.id, session, turn, event, signal));
        turn.applied = true; turn.buildId = applied.buildId;
        recordEvent(turn, { id: 'apply', kind: 'apply', label: '应用修改并刷新', status: 'completed' });
      }
      if (this.edits && commit && !signal.aborted) {
        try {
          await this.event(project.definition.id, session, turn, { id: 'git-commit', kind: 'commit', label: '提交 Git', status: 'running' }, signal);
          turn.commitId = await this.edits.commit(project.definition.id, access.commitMessage ?? turn.summary!);
          recordEvent(turn, { id: 'git-commit', kind: 'commit', label: '提交 Git', status: 'completed', output: turn.commitId ?? '没有需要提交的修改' });
          await this.event(project.definition.id, session, turn, turn.events!.find(event => event.id === 'git-commit')!, signal).catch(() => {});
        }
        catch (error) { turn.warning = error instanceof Error ? error.message : '修改已应用，但 Git 提交失败。'; recordEvent(turn, { id: 'git-commit', kind: 'commit', label: '提交 Git', status: 'failed', output: turn.warning }); }
      }
      turn.status = 'completed'; turn.phase = 'complete'; turn.finishedAt = new Date().toISOString(); session.updatedAt = turn.finishedAt;
      await this.workspace.exclusive(() => this.store.save(project, session)); this.jobs.delete(session.id);
    } catch (error) {
      turn.status = signal.aborted ? (signal.reason === 'cancelled' ? 'cancelled' : 'failed') : 'failed';
      turn.error = signal.reason === 'cancelled' ? '请求已取消；源码未被修改。'
        : signal.aborted ? '模型请求超时或应用已关闭；源码未被修改。'
        : error instanceof ModelFailure ? error.message
        : '模型请求或候选校验失败；请检查连接、工程状态及上下文后重试。';
      turn.summary = null; turn.changes = []; delete turn.dependencies; turn.finishedAt = new Date().toISOString(); session.updatedAt = turn.finishedAt;
      turn.phase = 'complete'; finishEvents(turn, signal.aborted ? 'cancelled' : 'failed');
      for (const event of turn.activity ?? []) if (event.status === 'running') event.status = signal.aborted ? 'cancelled' : 'failed';
      // Persist into the captured project's own profile even after an active-project switch.
      await this.workspace.exclusive(async () => {
        await this.store.save(project, session).catch(() => {});
        this.jobs.delete(session.id);
      });
    } finally {
      clearTimeout(timer);
      if (aborted) signal.removeEventListener('abort', aborted);
      if (this.jobs.get(session.id) === job) this.jobs.delete(session.id);
    }
  }
  private event(projectId: string, session: DevelopmentSession, turn: DevelopmentTurn, event: DevelopmentEvent, signal: AbortSignal) {
    return this.workspace.withProject(projectId, async current => {
      signal.throwIfAborted(); recordEvent(turn, event); await this.store.save(current, session);
    });
  }
  private async cancel(projectId: string, sessionId: string): Promise<DevelopmentSession> {
    const job = await this.workspace.withProject(projectId, async project => {
      await this.store.load(project, sessionId);
      const active = this.jobs.get(sessionId); active?.controller.abort('cancelled'); return active;
    });
    if (job) await job.done;
    return this.workspace.withProject(projectId, async project => structuredClone(await this.load(project, sessionId)));
  }
  async dispose(): Promise<void> {
    this.closed = true;
    const jobs = await this.workspace.exclusive(async () => [...this.jobs.values()]);
    for (const job of jobs) job.controller.abort('closed');
    await Promise.all(jobs.map(job => job.done));
  }
}
