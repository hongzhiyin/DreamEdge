import { accountFileAccess } from '../../src/files/account-access.js';
import { inspectFileMutation } from '../../src/files/mutation-policy.js';
import type { MutationPolicy } from '../../src/files/mutation-policy.js';
import { mkdtemp, mkdir, rm, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { ConversationService, PiRuntime, SqliteSessionStore, builtInTools, scopedReadTools, scopedMutationTools } from '../../src/index.js';
import type { ApprovalRecord, ApprovalDecisionCommand } from '../../src/index.js';
import type { MutationCommitHooks } from '../../src/files/mutation-commit.js';
import { modelServer, connection } from './server.js';
import type { Handler } from './server.js';
import { waitUntil } from './storage.js';

export async function mutationFixture(t: TestContext, handler: Handler, hooks: MutationCommitHooks = {}, ttlMs = 120_000, options: { account?: boolean; policy?: MutationPolicy; protectRoot?: boolean } = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'dreamedge-mutation-'))); const root = join(directory, 'files');
  await mkdir(root); await writeFile(join(root, 'note.txt'), 'alpha\nbeta\n');
  const server = await modelServer(handler); const registry = builtInTools();
  const config = connection(server.baseUrl, { thinkingLevel: 'high', timeoutMs: 30_000,
    toolCalling: { supported: true, supportedThinkingLevels: ['off', 'high'] } });
  const store = new SqliteSessionStore(join(directory, 'sessions.sqlite'));
  const account = options.account ? await accountFileAccess(root, options.protectRoot ? [root] : []) : undefined;
  const service = new ConversationService({ store, ...(account ? { deviceAccess: () => account } : { directoryPicker: async () => root }), connection: () => config,
    tools: () => registry.snapshots(), runtime: config => new PiRuntime(config, async () => 'fixture-key', { registry, approvalTtlMs: ttlMs }) });
  const cache = join(directory, 'cache'); await mkdir(cache);
  for (const tool of await scopedReadTools(service.fileScopes, {}, cache)) registry.register(tool);
  for (const tool of await scopedMutationTools(service.fileScopes, hooks, options.account ? options.policy ?? inspectFileMutation : undefined)) registry.register(tool);
  const sessionId = service.createSession({ connectionId: config.id }).sessionId;
  const grant = account ? service.fileScopes.roots(sessionId)[0] : await service.fileScopes.chooseDirectory(sessionId, { mode: 'read-write', remember: true });
  t.after(async () => { await service.dispose().catch(() => {}); store.close(); await server.close(); await rm(directory, { recursive: true, force: true }); });
  const send = (id = 'one', sid = sessionId) => service.send({ sessionId: sid, clientMessageId: id, text: id });
  const approval = async (sid = sessionId): Promise<ApprovalRecord> => {
    await waitUntil(() => service.getSnapshot(sid).runs.at(-1)?.approvals?.some(a => a.status === 'pending') ?? false);
    return service.getSnapshot(sid).runs.at(-1)!.approvals!.find(a => a.status === 'pending')!;
  };
  return { service, registry, store, config, server, root, directory, sessionId, grant: grant!, send, approval };
}
export function mutationDecision(a: ApprovalRecord, decision: 'approve' | 'reject' = 'approve'): ApprovalDecisionCommand {
  return { sessionId: a.sessionId, runId: a.runId, turnId: a.turnId, toolCallId: a.toolCallId,
    toolName: a.toolName, toolVersion: a.toolVersion, argsDigest: a.argsDigest, approvalId: a.approvalId, decision,
    ...(a.batch ? { batchDigest: a.batch.digest } : {}),
    ...(a.file ? { planDigest: a.file.planDigest, policyVersion: a.file.policyVersion } : {}) };
}
