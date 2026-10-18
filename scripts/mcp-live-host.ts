import { _electron as electron } from 'playwright';
import type { ElectronApplication, Page } from 'playwright';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { ChatView, ChatToolCall } from '../src/chat/types.js';
import type { McpControlView } from '../src/mcp/control-types.js';
export interface McpWire { high: boolean; status?: number; tools: number; hasPriorResult: boolean }
export const attempt = (v: ChatView) => v.messages.at(-1)!.attempts.at(-1)!;
export const calls = (v: ChatView): ChatToolCall[] => attempt(v).timeline?.flatMap(i => i.kind === 'tool' ? [i.call] : []) ?? [];
export class McpLiveHost {
  app!: ElectronApplication; page!: Page; sessionId = ''; readonly requests: McpWire[] = [];
  constructor(readonly directory: string, readonly executable: string, readonly config: string,
    readonly credentials: string, readonly baseUrl: string, readonly readerProfile: string) {}
  async launch() {
    const env: NodeJS.ProcessEnv = { ...process.env, DREAMEDGE_DATA_DIR: join(this.directory, 'profile'),
      DREAMEDGE_CONFIG_FILE: resolve(this.config), DREAMEDGE_CREDENTIALS_FILE: resolve(this.credentials),
      DREAMEDGE_NO_DIALOGS: '1', DREAMEDGE_MCP_READER_PROFILE: this.readerProfile };
    delete env.ELECTRON_RUN_AS_NODE;
    this.app = await electron.launch({ executablePath: resolve(this.executable), args: [], env: env as Record<string,string>, timeout: 20000 });
    this.page = await this.app.firstWindow(); await this.page.getByLabel('消息', { exact: true }).waitFor();
    await this.app.evaluate((_electron, target) => {
      const state = globalThis as unknown as { mcpProbe: McpWire[] }; state.mcpProbe = [];
      const original = globalThis.fetch;
      globalThis.fetch = async (input, init) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        let item: McpWire | undefined;
        if (url.startsWith(target) && typeof init?.body === 'string') {
          const body = JSON.parse(init.body); item = { high: body.reasoning_effort === 'high' && body.thinking?.type === 'enabled',
            tools: body.tools?.length ?? 0, hasPriorResult: body.messages?.some((m: { role: string }) => m.role === 'tool') === true };
          state.mcpProbe.push(item);
        }
        const response = await original(input, init); if (item) item.status = response.status; return response;
      };
    }, this.baseUrl);
  }
  async newSession() {
    this.sessionId = await this.page.evaluate(async () => (await window.dreamedge.createSession()).sessionId); return this.sessionId;
  }
  control(type: string, fields: Record<string, unknown> = {}): Promise<McpControlView> {
    return this.page.evaluate(({ type, fields, sessionId }) => window.dreamedgeMcp!.request({ type, sessionId, ...fields }),
      { type, fields, sessionId: this.sessionId });
  }
  async configure(serverId: string, transport: unknown) {
    const view = await this.control('register', { config: { format: 'dreamedge-mcp-server/v1', serverId, displayName: serverId,
      configRevision: 1, enabled: true, requestTimeoutMs: 60_000, transport, policy: { connect: 'ask', tools: 'ask', resources: 'ask' } } });
    const identity = view.servers.find(s => s.config.serverId === serverId)!.identity;
    await this.control('approve', { identity }); return identity;
  }
  async select(serverId: string) {
    const view = await this.control('snapshot'); const identity = view.servers.find(s => s.config.serverId === serverId)!.identity;
    await this.control('pin', { identity }); return this.control('connect', { identity });
  }
  view(): Promise<ChatView> { return this.page.evaluate(async id => {
    const result = await window.dreamedge.watch(id); if (result.kind !== 'snapshot') throw new Error('Expected snapshot'); return result.event.view;
  }, this.sessionId); }
  async send(text: string) { return this.page.evaluate(input => window.dreamedge.send(input),
    { sessionId: this.sessionId, clientMessageId: crypto.randomUUID(), text, thinkingLevel: 'high' as const }); }
  async wait(test: (v: ChatView) => boolean, ms = 120_000) {
    const end = Date.now() + ms;
    while (Date.now() < end) { const v = await this.view(); if (test(v)) return v; await delay(100); }
    throw new Error('Acceptance state timeout');
  }
  async decision(call: ChatToolCall, decision: 'approve' | 'reject') {
    if (!call.approval) throw new Error('No approval');
    const a = call.approval;
    await this.page.evaluate(command => window.dreamedge.decideApproval!(command), {
      sessionId: a.sessionId, runId: a.runId, turnId: a.turnId, toolCallId: a.toolCallId,
      toolName: a.toolName, toolVersion: a.toolVersion, argsDigest: a.argsDigest, approvalId: a.approvalId, decision,
    });
  }
  async finish(allowed: string[], decision: 'approve' | 'reject' = 'approve') {
    const decided = new Set<string>(); const end = Date.now() + 180_000;
    while (Date.now() < end) {
      const v = await this.view(); if (!v.activeRunId && v.saving.status === 'saved') return v;
      for (const call of calls(v)) if (call.status === 'awaiting_approval' && call.approval && !decided.has(call.approval.approvalId)) {
        if (!allowed.includes(call.origin?.toolName ?? '') || decided.size >= 6) {
          await this.decision(call, 'reject'); throw new Error('Unexpected live tool request');
        }
        await this.decision(call, decision); decided.add(call.approval.approvalId);
      }
      await delay(100);
    } throw new Error('Live run timeout');
  }
  async stop() { const v = await this.view(); if (v.activeRunId) await this.page.evaluate(v => window.dreamedge.stop(v.sessionId, v.runId), { sessionId: v.sessionId, runId: v.activeRunId }); }
  async close(crash = false) {
    this.requests.push(...await this.app.evaluate(() => (globalThis as unknown as { mcpProbe: McpWire[] }).mcpProbe).catch(() => []));
    const process = this.app.process();
    if (crash) process.kill('SIGKILL'); else await Promise.race([this.app.close(), delay(5000)]).catch(() => {});
    if (process.exitCode === null && process.signalCode === null) process.kill('SIGKILL');
    await delay(250);
  }
}
