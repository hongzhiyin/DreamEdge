import { access, readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { FileLiveHost, fileCalls, latestAttempt } from './file-live-host.js';
import type { ChatView } from '../src/chat/types.js';

export interface FileLiveCase { name: string; passed: boolean; checks: Record<string, boolean>; tools: { name: string; status: string }[]; durationMs: number }
const missing = (path: string) => access(path).then(() => false, error => (error as NodeJS.ErrnoException).code === 'ENOENT');
const text = (view: ChatView) => fileCalls(view).flatMap(call => call.result?.content.flatMap(block => block.type === 'text' ? [block.text] : []) ?? []).join('\n');
const confirmed = (view: ChatView, name: string) => fileCalls(view).some(call => call.name === name && call.status === 'succeeded');

export async function runFileLiveCases(host: FileLiveHost, cases: FileLiveCase[], cancelOnly = false) {
  async function run(name: string, operation: () => Promise<{ view: ChatView; checks: Record<string, boolean> }>) {
    process.stderr.write(`开始文件真实验收：${name}\n`); const began = Date.now();
    try {
      const { view, checks } = await operation();
      checks.saved = view.saving.status === 'saved'; checks.noRendererErrors = host.errors.length === 0;
      const item = { name, checks, passed: Object.values(checks).every(Boolean), durationMs: Date.now() - began,
        tools: fileCalls(view).map(call => ({ name: call.name, status: call.status })) };
      cases.push(item); process.stdout.write(`${JSON.stringify(item)}\n`);
      if (!item.passed) throw new Error('File acceptance checks failed');
    } catch (error) {
      if (cases.at(-1)?.name !== name) cases.push({ name, passed: false, checks: { operationCompleted: false }, tools: [], durationMs: Date.now() - began });
      throw error;
    }
  }
  await host.choose('read');
  if (cancelOnly) { await run('cancel-stream-after-read-result', () => cancelReadReply(host)); return; }
  await run('read-list-find-grep', async () => {
    await host.send('只使用文件工具完成：先 ls 列出授权目录，再 find 查找 *.txt，再 grep 搜索 ORCHID，最后 read 读取 note.txt。四种工具各调用至少一次，不调用其他工具。最后仅返回文件中的 sample-id。');
    const view = await host.settled(); const requests = await host.currentRequests();
    return { view, checks: { completed: latestAttempt(view).status === 'completed', highThinking: latestAttempt(view).thinkingLevel === 'high',
      fourTools: ['ls', 'find', 'grep', 'read'].every(name => confirmed(view, name)),
      actualMarker: text(view).includes('ORCHID-7319') && latestAttempt(view).text.includes('ORCHID-7319'),
      noSnapshotPathLeak: !text(view).includes('dreamedge-file-snapshot-'),
      readOnlyCatalog: requests.length > 0 && requests.every(request => ['read', 'ls', 'find', 'grep'].every(name => request.tools.includes(name)) && !request.tools.includes('write') && !request.tools.includes('edit')),
      highOnWire: requests.every(request => request.high), nativeReasoningReplayed: requests.some(request => request.reasoningReplayed) } };
  });
  await run('follow-up-reuses-file-result', async () => {
    await host.send('上轮工具实际读取的 sample-id 是什么？不再调用工具，只返回那个编号。'); const view = await host.settled();
    return { view, checks: { completed: latestAttempt(view).status === 'completed', marker: latestAttempt(view).text.trim() === 'ORCHID-7319', noNewCalls: fileCalls(view).length === 0 } };
  });
  await host.revoke(); await host.choose('read-write');
  await run('create-preview-and-approval', async () => {
    await host.send('用 write 新建 new.txt，内容精确为 "DreamEdge verified\n"。仅做这一次文件写入，不调用其他工具。授权后简短说明结果。');
    const pending = await host.approval('new.txt'); const before = await missing(join(host.root, 'new.txt'));
    const preview = fileCalls(pending).find(call => call.preview?.path.endsWith('/new.txt'))?.preview;
    await host.card('new.txt').getByRole('button', { name: '允许这一次' }).click(); const view = await host.settled();
    return { view, checks: { noWriteBeforeApproval: before, realPreview: preview?.operation === 'create' && preview.patch.includes('DreamEdge verified'),
      succeeded: confirmed(view, 'write'), exactFile: await readFile(join(host.root, 'new.txt'), 'utf8') === 'DreamEdge verified\n',
      completed: latestAttempt(view).status === 'completed' } };
  });
  await run('read-edit-and-version-receipt', async () => {
    await host.send('先用 read 读取 note.txt，再用 edit 将精确文本 "status: draft" 替换为 "status: verified"，保留其他内容。只做这一个编辑，授权后简短回复。');
    const pending = await host.approval('note.txt'); const unchanged = await readFile(join(host.root, 'note.txt'), 'utf8') === 'sample-id: ORCHID-7319\nstatus: draft\n';
    const preview = fileCalls(pending).find(call => call.name === 'edit')?.preview;
    await host.card('note.txt').getByRole('button', { name: '允许这一次' }).click(); const view = await host.settled();
    await host.card('note.txt').getByText('已写入并核对文件版本。', { exact: true }).waitFor();
    await mkdir('docs/validation', { recursive: true }); await host.page.screenshot({ path: 'docs/validation/file-deepseek-2026-10-15.png' });
    return { view, checks: { readBeforeEdit: confirmed(view, 'read'), unchangedBeforeApproval: unchanged,
      editPreview: preview?.operation === 'edit' && preview.patch.includes('-status: draft') && preview.patch.includes('+status: verified'),
      succeeded: confirmed(view, 'edit'), exactFile: await readFile(join(host.root, 'note.txt'), 'utf8') === 'sample-id: ORCHID-7319\nstatus: verified\n',
      completed: latestAttempt(view).status === 'completed' } };
  });
  await run('reload-preview-and-reject', async () => {
    await host.send('用 write 新建 rejected.txt，写入一行 "rejected sample"。仅调用一次 write；如果被拒绝，说明拒绝，不换路径或重试。');
    const pending = await host.approval('rejected.txt'); const id = pending.activeRunId;
    const requests = (await host.currentRequests()).length;
    await host.page.reload(); await host.card('rejected.txt').getByRole('button', { name: '拒绝', exact: true }).waitFor();
    const restored = await host.view(); const noNewRequest = (await host.currentRequests()).length === requests;
    await host.card('rejected.txt').getByRole('button', { name: '拒绝', exact: true }).click(); const view = await host.settled();
    return { view, checks: { sameRun: restored.activeRunId === id, noRequestOnReload: noNewRequest,
      rejected: fileCalls(view).some(call => call.name === 'write' && call.status === 'rejected'),
      absent: await missing(join(host.root, 'rejected.txt')), noSuccess: !confirmed(view, 'write'), completed: latestAttempt(view).status === 'completed' } };
  });
  await run('stop-pending-write', async () => {
    await host.send('用 write 新建 stopped.txt，内容为 "stopped sample"。只调用这一次，不调用其他工具。');
    await host.approval('stopped.txt'); await host.page.getByRole('button', { name: '停止生成' }).click(); const view = await host.settled();
    const requests = (await host.currentRequests()).length; await delay(500);
    return { view, checks: { cancelled: latestAttempt(view).status === 'cancelled', callCancelled: fileCalls(view).some(call => call.status === 'cancelled'),
      absent: await missing(join(host.root, 'stopped.txt')), noRequestsAfterStop: (await host.currentRequests()).length === requests } };
  });
  await run('revoke-during-preview', async () => {
    await host.send('用 write 新建 revoked.txt，写入 "revoked sample"。仅尝试一次；权限失败后说明失败，不重试或调用其他工具。');
    await host.approval('revoked.txt'); await host.revoke();
    await host.card('revoked.txt').getByRole('button', { name: '允许这一次' }).click(); const view = await host.settled();
    return { view, checks: { noWrite: await missing(join(host.root, 'revoked.txt')), noSuccess: !confirmed(view, 'write'),
      explicitFailure: fileCalls(view).some(call => ['failed', 'rejected'].includes(call.status)), completed: latestAttempt(view).status === 'completed' } };
  });
  await host.choose('read-write');
  await run('restart-restores-grants-and-cards', async () => {
    const before = await host.view(); const count = await host.page.getByTestId('tool-card').count();
    await host.close(); await host.launch(); const view = await host.view();
    return { view, checks: { sameSession: view.sessionId === before.sessionId,
      sameCards: await host.page.getByTestId('tool-card').count() === count,
      sameScope: JSON.stringify(view.fileScope) === JSON.stringify(before.fileScope), noRequestOnRestart: (await host.currentRequests()).length === 0,
      originalFiles: await readFile(join(host.root, 'new.txt'), 'utf8') === 'DreamEdge verified\n',
      editedFile: (await readFile(join(host.root, 'note.txt'), 'utf8')).includes('status: verified') } };
  });
  await run('read-after-application-restart', async () => {
    await host.send('调用 read 重新读取 note.txt，再简短回复其中 status 的实际值，不调用其他工具。'); const view = await host.settled();
    return { view, checks: { completed: latestAttempt(view).status === 'completed', actualRead: confirmed(view, 'read'),
      actualEditedContent: text(view).includes('status: verified') && latestAttempt(view).text.includes('verified') } };
  });
  await run('cancel-stream-after-read-result', () => cancelReadReply(host));
}

async function cancelReadReply(host: FileLiveHost) {
  await host.send('先用 read 读取 note.txt。拿到工具结果后连续列出1000条文件整理建议，不要省略，只调用这个读取工具。');
  const streaming = await host.wait(view => {
    const attempt = latestAttempt(view); const tail = attempt.timeline?.at(-1);
    return attempt.status === 'running' && confirmed(view, 'read') && tail?.kind === 'model' && tail.text.length > 0;
  });
  const beforeStop = latestAttempt(streaming).timeline?.at(-1);
  await host.page.getByRole('button', { name: '停止生成' }).click(); const view = await host.settled();
  const count = (await host.currentRequests()).length; await delay(500);
  return { view, checks: { cancelled: latestAttempt(view).status === 'cancelled', retainedRead: confirmed(view, 'read'),
    postToolStream: beforeStop?.kind === 'model' && beforeStop.text.length > 0,
    partialText: latestAttempt(view).text.length > 0, noRequestsAfterStop: (await host.currentRequests()).length === count } };
}
