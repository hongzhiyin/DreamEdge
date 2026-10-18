import { operationLabels, previewBytes, previewDescription } from '../src/files/preview.js';
import { BatchDetails, BatchRecoveryAction, batchStatus } from './BatchDetails.js';
import { useEffect, useRef, useState } from 'react';
import { Check, ShieldCheck, Wrench } from 'lucide-react';
import type { ChatToolCall } from '../src/chat/types.js';
import type { ApprovalDecisionCommand } from '../src/runtime/tool-contracts.js';
import { FileToolResult } from './FileToolResult.js';
import { fileResultView } from '../src/chat/file-result.js';
import { ToolOutput } from './ToolOutput.js';

const labels = { requested: '准备调用', awaiting_approval: '等待确认', authorized: '已批准，待执行', running: '执行中', succeeded: '已完成',
  failed: '执行失败', rejected: '已拒绝', cancelled: '已取消', interrupted: '已中断', outcome_unknown: '结果未知' };
const clip = (value: string, limit = 20_000) => value.length > limit ? `${value.slice(0, limit)}\n…内容过长，已截断显示` : value;

export function ToolCard({ call, enabled, approve, sessionId, canResume }: { call: ChatToolCall; enabled: boolean;
  approve(command: ApprovalDecisionCommand): Promise<boolean>; sessionId?: string; canResume?: boolean }) {
  const approval = call.approval;
  const [expired, setExpired] = useState(false);
  const [busy, setBusy] = useState(false);
  const locked = useRef(false);
  useEffect(() => {
    setExpired(Boolean(approval && Date.now() >= approval.expiresAt));
    if (!approval || approval.status !== 'pending') return;
    const timer = setTimeout(() => setExpired(true), Math.max(0, approval.expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [approval?.approvalId, approval?.expiresAt, approval?.status]);
  const automatic = approval?.inspection?.decision === 'allow';
  const waiting = !automatic && (!approval?.batch || !!approval.batchPlan) && call.status === 'awaiting_approval' && approval?.status === 'pending';
  async function decide(decision: 'approve' | 'reject') {
    if (!approval || locked.current || !enabled || expired) return;
    locked.current = true; setBusy(true);
    const accepted = await approve({ sessionId: approval.sessionId, runId: approval.runId, turnId: approval.turnId,
      toolCallId: approval.toolCallId, approvalId: approval.approvalId, toolName: approval.toolName,
      toolVersion: approval.toolVersion, argsDigest: approval.argsDigest, decision,
      ...(approval.batch ? { batchDigest: approval.batch.digest } : {}),
      ...(approval.file ? { planDigest: approval.file.planDigest, policyVersion: approval.file.policyVersion } : {}) });
    if (!accepted) { locked.current = false; setBusy(false); }
  }
  const summary = call.result?.content.filter(block => block.type === 'text').map(block => block.text).join(' ') ?? '';
  const file = fileResultView(call);
  const status = call.batchItems ? batchStatus(call.batchItems) : call.status;
  return <section className={`tool-card ${status}`} data-testid="tool-card" data-status={status} aria-label={`工具：${call.label}`}>
    <header className="tool-heading"><Wrench size={16} /><span className="tool-name">{call.batchItems ? `文件批量计划（${call.batchItems.length} 项）` : call.label}</span>
      <span className="tool-status">{automatic && call.status === 'awaiting_approval' ? '检查通过' : approval?.status === 'expired' ? '授权过期' : labels[status]}</span></header>
    {call.origin && <p className="scope-help">来源：{call.origin.serverId} · {call.origin.toolName} · 配置 {call.origin.configRevision} / 目录 {call.origin.catalogRevision}</p>}
    {approval?.inspection && <p className="scope-help">{automatic ? '自动检查通过' : '敏感操作'}：{approval.inspection.reason}</p>}
    {call.result && !file && <p className="tool-summary">{summary.slice(0, 150) || '工具已返回结果。'}</p>}
    {file && !call.batchItems && <FileToolResult call={call} />}
    {call.error && <p className="tool-error" role="status">{call.error}</p>}
    {call.batchItems && <BatchDetails items={call.batchItems} />}
    {call.preview && !call.batchItems && <div className="file-preview" aria-label="文件变更预览">
      <p>{operationLabels[call.preview.operation]}：{call.preview.path}</p>
      <p>{call.preview.kind === 'file_mutation' ? `原版本：${call.preview.before.kind === 'absent' ? '文件不存在' : call.preview.before.version.sha256.slice(0, 12)}` : `清单：${call.preview.tree?.entries.length ?? 0} 项`} · {previewBytes(call.preview)} 字节</p>
      <details open={waiting || undefined}><summary>变更差异</summary><pre>{previewDescription(call.preview) || '内容没有变化。'}</pre></details>
    </div>}
    {waiting && <div className="tool-permission">
      <p><ShieldCheck size={15} />{call.origin ? call.origin.kind === 'mcp-resource' ? '读取外部资源并发送给当前模型，需要确认。' : '外部工具可能修改内容，需要确认。' : call.effect === 'write' ? '此操作会修改内容，需要确认。' : '此工具需要你的确认。'}</p>
      <p>操作对象：{call.batchItems ? `上方列出的 ${call.batchItems.length} 项操作` : call.preview?.path ?? (call.resources.join('、') || '未指定')}</p>
    </div>}
    <details className="tool-details" open={waiting && !call.preview || undefined}><summary>参数与详情</summary>
      <p>工具：{call.name} · 版本 {call.version} · {call.effect === 'write' ? '写入操作' : '读取操作'}</p>
      <p>参数</p><pre>{clip(JSON.stringify(call.args, null, 2))}</pre>
      {call.result && <>{!file && <><p>结果</p><ToolOutput result={call.result} /></>}
        {call.result.details !== undefined && <pre>{clip(JSON.stringify(call.result.details, null, 2))}</pre>}</>}
    </details>
    {waiting && <div className="tool-actions" aria-label="工具授权">
      <button className="tool-confirm" disabled={!enabled || expired || busy} onClick={() => { void decide('approve'); }}>
        <Check size={15} />{busy ? '正在提交…' : call.batchItems ? '允许本批操作' : '允许这一次'}</button>
      <button className="text-button" disabled={!enabled || expired || busy} onClick={() => { void decide('reject'); }}>拒绝</button>
      {expired && <span role="status">授权已过期</span>}
    </div>}
    {call.batchRecovery && sessionId && <BatchRecoveryAction recovery={call.batchRecovery} sessionId={sessionId} enabled={Boolean(canResume)} />}
    {call.status === 'outcome_unknown' && <p className="tool-warning">请先核对实际结果；不能直接重试此操作。</p>}
  </section>;
}
