import { operationLabels, previewBytes, previewDescription } from '../src/files/preview.js';
import { useState } from 'react';
import type { ChatToolCall } from '../src/chat/types.js';

const statuses = { requested: '准备中', awaiting_approval: '待确认', authorized: '已批准，未执行', running: '执行中',
  succeeded: '已完成', failed: '失败，未提交', rejected: '未获许可', cancelled: '已停止', interrupted: '未执行，中断', outcome_unknown: '结果未知，需核对' };
export function batchStatus(items: NonNullable<ChatToolCall['batchItems']>) {
  for (const status of ['outcome_unknown', 'awaiting_approval', 'running', 'authorized', 'failed', 'interrupted', 'cancelled', 'rejected'] as const) {
    if (items.some(item => item.status === status)) return status;
  }
  return items.every(item => item.status === 'succeeded') ? 'succeeded' : 'requested';
}
export function BatchDetails({ items }: { items: NonNullable<ChatToolCall['batchItems']> }) {
  return <div aria-label="批量计划清单" className="file-preview">
    <p>已完成 {items.filter(i => i.status === 'succeeded').length}／{items.length} 项。一次确认仅覆盖以下目标和差异。</p>
    {items.some(item => item.preview.operation === 'delete') && <p className="tool-warning">本批包含永久删除，不能从废纸篓恢复。</p>}
    {items.map(item => <details key={item.toolCallId}>
      <summary>{operationLabels[item.preview.operation]} {item.preview.path} · {statuses[item.status]}</summary>
      <p>{item.reason}</p><p>变更后 {previewBytes(item.preview)} 字节</p><pre>{previewDescription(item.preview) || '内容没有变化。'}</pre>
      {item.error && <p role="status">{item.error}</p>}
    </details>)}
  </div>;
}
export function BatchRecoveryAction({ recovery, sessionId, enabled }: {
  recovery: NonNullable<ChatToolCall['batchRecovery']>; sessionId: string; enabled: boolean;
}) {
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  async function resume() {
    if (busy || !enabled || !window.dreamedge.resumeBatch) return;
    setBusy(true); setError('');
    try { await window.dreamedge.resumeBatch({ sessionId, ...recovery.reference }); }
    catch (e) { setError(e instanceof Error ? e.message : '无法准备恢复计划。'); }
    finally { setBusy(false); }
  }
  return <div className="tool-actions">
    {recovery.unavailable ? <p role="status">{recovery.unavailable}</p> : <>
      <p>剩余 {recovery.remaining} 项。恢复会读取当前版本，重新生成预览并确认。</p>
      <button className="text-button" disabled={!enabled || busy || !window.dreamedge.resumeBatch} onClick={() => { void resume(); }}>准备恢复未完成项</button>
    </>}
    {error && <p role="alert">{error}</p>}
  </div>;
}
