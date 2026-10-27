import type { TestContext } from 'node:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { builtInTools, ConversationService, PiRuntime, scopedMutationTools, scopedReadTools, SqliteSessionStore } from '../../src/index.js';
import { accountFileAccess } from '../../src/files/account-access.js';
import { inspectFileMutation } from '../../src/files/mutation-policy.js';
import type { ApprovalRecord } from '../../src/tools/types.js';
import type { MutationCommitHooks } from '../../src/files/mutation-commit.js';
import { mutationFixture } from './mutation-loop.js';
import { waitUntil } from './storage.js';

export const batchReference = (receipt: ApprovalRecord) => ({ sessionId: receipt.sessionId, sourceRunId: receipt.runId,
  approvalId: receipt.approvalId, digest: receipt.batchPlan!.digest });
export async function seedBatch(root: string) {
  for (const name of ['note.txt', 'second.txt', 'third.txt']) await writeFile(join(root, name), `original ${name}\n`);
}
export async function reopenBatch(t: TestContext, original: Awaited<ReturnType<typeof mutationFixture>>, hooks: MutationCommitHooks = {}) {
  await original.service.dispose();
  const store = new SqliteSessionStore(join(original.directory, 'sessions.sqlite')); const registry = builtInTools();
  const policy = await accountFileAccess(original.root);
  const service = new ConversationService({ store, connection: () => original.config, deviceAccess: () => policy,
    tools: () => registry.snapshots(), runtime: config => new PiRuntime(config, async () => 'fixture-key', { registry }) });
  const cache = join(original.directory, 'restored-cache'); await mkdir(cache, { recursive: true });
  for (const tool of await scopedReadTools(service.fileScopes, {}, cache, 'account')) registry.register(tool);
  for (const tool of await scopedMutationTools(service.fileScopes, hooks, inspectFileMutation)) registry.register(tool);
  original.beforeCleanup(async () => { await service.dispose().catch(() => {}); store.close(); });
  const approval = async (): Promise<ApprovalRecord> => {
    await waitUntil(() => service.getSnapshot(original.sessionId).runs.at(-1)?.approvals?.some(a => a.status === 'pending') ?? false, 20_000);
    return service.getSnapshot(original.sessionId).runs.at(-1)!.approvals!.find(a => a.status === 'pending')!;
  };
  return { service, store, approval, registry };
}
