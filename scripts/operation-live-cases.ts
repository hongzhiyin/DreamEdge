import assert from 'node:assert/strict';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FileLiveHost, fileCalls, latestAttempt } from './file-live-host.js';
import type { ChatView } from '../src/chat/types.js';
import type { FileLiveCase } from './file-live-cases.js';
const missing = (path: string) => access(path).then(() => false, e => (e as NodeJS.ErrnoException).code === 'ENOENT');
const success = (view: ChatView, name: string) => fileCalls(view).some(c => c.name === name && c.status === 'succeeded');
const members = (view: ChatView) => fileCalls(view).flatMap(c => c.batchItems ?? []);
const decision = (host: FileLiveHost) => host.page.getByRole('button', { name: '允许本批操作', exact: true });
export async function runOperationCases(host: FileLiveHost, cases: FileLiveCase[]) {
  async function run(name: string, action: () => Promise<{ view: ChatView; checks: Record<string, boolean> }>) {
    process.stdout.write(`开始：${name}\n`); const started = Date.now();
    try {
      const { view, checks } = await action(); checks.saved = view.saving.status === 'saved'; checks.noRendererErrors = host.errors.length === 0;
      const result = { name, passed: Object.values(checks).every(Boolean), checks, durationMs: Date.now() - started,
        tools: fileCalls(view).map(c => ({ name: c.name, status: c.status })) };
      cases.push(result); process.stdout.write(`${JSON.stringify(result)}\n`); assert.ok(result.passed, name);
    } catch (error) { if (cases.at(-1)?.name !== name) cases.push({ name, passed: false, checks: { completed: false }, tools: [], durationMs: Date.now() - started }); throw error; }
  }
  const trash = join(host.root, 'trash-fixture.txt'), permanent = join(host.root, 'permanent-fixture');
  await writeFile(trash, 'trash fixture only'); await mkdir(permanent); await writeFile(join(permanent, 'leaf.bin'), Buffer.from([0, 255, 1]));
  const prompt = `本次仅操作以下明确的测试对象：${JSON.stringify([{ path: trash }, { path: permanent, permanent: true }])}。请在同一条助手消息中发出两个独立的 delete 工具调用，形成同一批计划。第一项移到废纸篓，第二项永久删除目录及其文件。不要逐项等待，也不要添加其他工具。如果被拒绝或失败，说明情况并结束，不重试、不换工具。`;
  async function pending() {
    const view = await host.wait(v => !v.activeRunId || fileCalls(v).some(c => c.status === 'awaiting_approval'));
    assert.equal(members(view).length, 2, 'Expected two independent calls in one pending batch');
    assert.equal(await decision(host).count(), 1); assert.equal(await host.page.getByRole('button', { name: '允许这一次', exact: true }).count(), 0);
    await access(trash); await access(join(permanent, 'leaf.bin')); return view;
  }
  await run('mkdir-copy-move-account-access', async () => {
    const output = join(host.root, 'output'); const source = join(host.root, 'source.bin'); const data = Buffer.from([0, 255, 12, 89]); await writeFile(source, data);
    await host.send(`仅在 ${host.root} 中按依赖顺序使用 mkdir、copy、move 各一次：创建 ${output}，将 ${source} 复制到 ${output}/copy.bin，然后移动该副本到 ${output}/moved.bin。不要调用其他工具，完成后简短回答。`);
    const view = await host.settled();
    return { view, checks: { completed: latestAttempt(view).status === 'completed', threeTools: ['mkdir', 'copy', 'move'].every(n => success(view, n)),
      exactBinary: (await readFile(join(output, 'moved.bin'))).equals(data), sourcePreserved: (await readFile(source)).equals(data), oldDestinationAbsent: await missing(join(output, 'copy.bin')),
      noManualPrompt: !(latestAttempt(view).approvals ?? []).some(a => a.inspection?.decision === 'ask') } };
  });
  await run('batch-reload-reject', async () => {
    await host.send(prompt); const before = await pending(); const requests = (await host.currentRequests()).length;
    await host.page.reload(); await decision(host).waitFor(); const restored = await host.view();
    const noNewRequest = (await host.currentRequests()).length === requests;
    await host.page.getByRole('button', { name: '拒绝', exact: true }).last().click(); const view = await host.settled();
    return { view, checks: { oneBatch: members(before).length === 2, sameRun: restored.activeRunId === before.activeRunId, noRequestOnReload: noNewRequest,
      rejected: members(view).every(m => m.status === 'rejected'), trashUnchanged: await readFile(trash, 'utf8') === 'trash fixture only',
      permanentUnchanged: (await readFile(join(permanent, 'leaf.bin'))).equals(Buffer.from([0, 255, 1])) } };
  });
  await run('stop-batch-before-execution', async () => {
    await host.send('这是新的独立验收请求，上一轮拒绝测试已结束。现在明确要求重新提出下列计划，等待本次确认；上一轮不重试的要求仅限上一轮。' + prompt); await pending(); await host.page.getByRole('button', { name: '停止生成' }).click(); const view = await host.settled();
    await access(trash); await access(join(permanent, 'leaf.bin'));
    return { view, checks: { cancelled: latestAttempt(view).status === 'cancelled', noWrites: members(view).every(m => m.status === 'cancelled'),
      recoverable: fileCalls(view).some(c => c.batchRecovery?.remaining === 2) } };
  });
  await run('restart-recover-reconfirm-native-trash-and-permanent-delete', async () => {
    const before = await host.view(); const oldDigest = fileCalls(before).find(c => c.approval?.batchPlan)?.approval?.batchPlan?.digest;
    await host.close(); await host.launch(); const restored = await host.view();
    const noRestartRequest = (await host.currentRequests()).length === 0; await access(trash); await access(join(permanent, 'leaf.bin'));
    await host.page.getByRole('button', { name: '准备恢复未完成项', exact: true }).last().click(); const preview = await pending();
    const newDigest = fileCalls(preview).find(c => c.approval?.batchPlan)?.approval?.batchPlan?.digest;
    await host.page.screenshot({ path: 'docs/validation/file-policy-live-batch-2026-10-17.png' });
    await decision(host).click(); const view = await host.settled();
    return { view, checks: { sameSession: before.sessionId === restored.sessionId, noRestartRequest, freshPlan: !!newDigest && oldDigest !== newDigest,
      twoCommitted: members(view).length === 2 && members(view).every(m => m.status === 'succeeded'),
      trashSourceAbsent: await missing(trash), permanentTreeAbsent: await missing(permanent), completed: latestAttempt(view).status === 'completed' } };
  });
  await run('new-plan-needs-confirmation-and-rechecks-version', async () => {
    const paths = ['changed.txt', 'untouched.txt'].map(n => join(host.root, n)); for (const p of paths) await writeFile(p, 'before');
    await host.send(`仅对 ${JSON.stringify(paths)} 各调用一次 delete，permanent 都设为 true；两个调用必须在同一条助手消息中发出。等待本批确认。失败后不重试、不换工具，简短解释失败。`);
    const pending = await host.wait(v => members(v).length === 2 && members(v).some(m => m.status === 'awaiting_approval'));
    await writeFile(paths[0]!, 'changed externally after preview'); await decision(host).click(); const view = await host.settled();
    return { view, checks: { freshConfirmation: members(pending).every(m => m.status === 'awaiting_approval'),
      noneCommitted: members(view).every(m => m.status !== 'succeeded'), versionFailure: members(view).some(m => m.status === 'failed'),
      changedPreserved: await readFile(paths[0]!, 'utf8') === 'changed externally after preview', untouchedPreserved: await readFile(paths[1]!, 'utf8') === 'before' } };
  });
  await run('restart-history-no-replay', async () => {
    const before = await host.view(), requests = (await host.currentRequests()).length;
    assert.ok(requests > 0); await host.close(); await host.launch(); const view = await host.view();
    return { view, checks: { historyPreserved: JSON.stringify(view.messages) === JSON.stringify(before.messages), noRequestOnRestart: (await host.currentRequests()).length === 0,
      deletedRemainAbsent: await missing(trash) && await missing(permanent) } };
  });
}
