import { setTimeout as delay } from 'node:timers/promises';
import { attempt, calls, McpLiveHost } from './mcp-live-host.js';
import type { readerFixture } from './mcp-reader-fixture.js';
import type { ledgerFixture } from './mcp-ledger-fixture.js';
export interface McpLiveCase { name: string; passed: boolean; checks: Record<string, boolean> }
export async function mcpLiveCases(host: McpLiveHost, reader: Awaited<ReturnType<typeof readerFixture>>,
  ledger: Awaited<ReturnType<typeof ledgerFixture>>, cases: McpLiveCase[]) {
  const record = (name: string, checks: Record<string, boolean>) => {
    const item = { name, passed: Object.values(checks).every(Boolean), checks }; cases.push(item);
    process.stdout.write(JSON.stringify(item) + '\n'); if (!item.passed) throw new Error('Live acceptance failed');
  };
  await host.newSession();
  await host.configure('reader-app', { type: 'stdio', command: reader.executable, args: ['mcp'], envRefs: { RG_DESKTOP_DATA_DIR: 'env:DREAMEDGE_MCP_READER_PROFILE' } });
  const catalog = await host.select('reader-app'); const provider = catalog.servers.find(s => s.config.serverId === 'reader-app')!;
  record('real-provider-and-independent-client', { independentClientRead: reader.independentRead, independentToolCount: reader.tools >= 23,
    piReady: provider.connection?.state === 'ready', compatibleTools: provider.connection?.catalog?.tools.every(t => t.availability === 'compatible') === true });
  process.stderr.write('真实 DeepSeek：读取隔离阅读器测试 PDF。\n');
  await host.send(`请仅调用 rg_page_read 读取测试 PDF 第一页，参数严格使用 ${JSON.stringify(reader.input)}。不要查询其他信息，不调用其他工具；成功后只回答原文里是否有 Selecting original text。`);
  let view = await host.finish(['rg_page_read']);
  record('packaged-deepseek-reader-stdio', { completed: attempt(view).status === 'completed', high: attempt(view).thinkingLevel === 'high',
    oneRead: calls(view).length === 1 && calls(view)[0]?.status === 'succeeded', marker: JSON.stringify(calls(view)[0]?.result).includes('Selecting original text') });
  await host.newSession(); await host.configure('ledger-app', { type: 'streamable-http', url: ledger.url }); await host.select('ledger-app');
  process.stderr.write('真实 DeepSeek：HTTP 台账批准执行与拒绝。\n');
  await host.send('只调用一次 record_entry，label 为 ACCEPTED-ONE，不设置 hold。操作成功后用一句话确认。');
  view = await host.finish(['record_entry']);
  record('packaged-deepseek-ledger-http-approve', { completed: attempt(view).status === 'completed', oneCommit: ledger.entries.join(',') === 'ACCEPTED-ONE',
    approved: calls(view).some(c => c.approval?.status === 'approved' && c.status === 'succeeded') });
  await host.newSession(); await host.select('ledger-app');
  await host.send('仅请求一次 record_entry，label 为 REJECTED-ONE。若宿主拒绝，直接结束，不能再次请求或换工具。');
  view = await host.finish(['record_entry'], 'reject');
  record('packaged-deepseek-rejection', { completed: attempt(view).status === 'completed', rejected: calls(view).some(c => c.status === 'rejected'), unchanged: ledger.entries.length === 1 });
  await host.newSession(); const resourceSession = host.sessionId; await host.select('ledger-app');
  process.stderr.write('真实 DeepSeek：按需资源读取。\n');
  await host.send('只调用一次读取资源工具 resources/read，读取 ledger://inventory，回答其中的验证代码，不调用 record_entry。');
  view = await host.finish(['resources/read']);
  record('packaged-deepseek-resource', { completed: attempt(view).status === 'completed', correctCode: attempt(view).text.includes('COBALT-4826'), oneRead: ledger.reads() === 1,
    sourceRetained: calls(view).some(c => c.origin?.kind === 'mcp-resource' && c.status === 'succeeded') });
  await host.newSession(); await host.select('ledger-app');
  await host.send('只请求一次 record_entry，label 为 CANCELLED-BEFORE-SEND，不设置 hold。');
  await host.wait(v => calls(v).some(c => c.status === 'awaiting_approval')); await host.stop();
  view = await host.wait(v => !v.activeRunId && v.saving.status === 'saved');
  record('packaged-stop-before-approval', { cancelled: attempt(view).status === 'cancelled', noCommit: ledger.entries.length === 1 });
  await host.newSession(); const crashedSession = host.sessionId; await host.select('ledger-app');
  process.stderr.write('真实 DeepSeek：写入后中断应用，检查未知结果不重放。\n');
  await host.send('只请求一次 record_entry，label 为 CRASH-AFTER-COMMIT，hold 必须为 true；这是隔离台账的中断恢复测试。');
  view = await host.wait(v => calls(v).some(c => c.status === 'awaiting_approval'));
  const call = calls(view).find(c => c.status === 'awaiting_approval')!;
  if (call.origin?.toolName !== 'record_entry' || call.args.label !== 'CRASH-AFTER-COMMIT' || call.args.hold !== true) throw new Error('Wrong crash test call');
  await host.decision(call, 'approve');
  await host.wait(v => calls(v).some(c => c.status === 'running') && ledger.entries.includes('CRASH-AFTER-COMMIT'));
  await host.close(true); await host.launch(); host.sessionId = crashedSession;
  view = await host.view(); await delay(500);
  record('packaged-crash-recovery-no-replay', { interrupted: attempt(view).status === 'interrupted', unknown: calls(view).some(c => c.status === 'outcome_unknown'),
    exactlyTwo: ledger.entries.join(',') === 'ACCEPTED-ONE,CRASH-AFTER-COMMIT' });
  host.sessionId = resourceSession;
  await host.send('只根据之前已读取的资源回答验证代码，不调用任何工具。'); view = await host.finish([]);
  record('packaged-history-after-restart', { completed: attempt(view).status === 'completed', correctCode: attempt(view).text.includes('COBALT-4826'), noNewCalls: !calls(view).length, noReread: ledger.reads() === 1 });
  const state = await host.control('snapshot'); const identity = state.servers.find(s => s.config.serverId === 'ledger-app')!.identity;
  await host.control('revoke', { identity }); await host.send('概括之前的库存资源。'); view = await host.finish([]);
  record('revoked-history-blocked', { blocked: attempt(view).status === 'failed', noReread: ledger.reads() === 1, noWrites: ledger.entries.length === 2 });
}
