import { useState } from 'react';
import type { McpControlView } from '../src/mcp/control-types.js';
export function McpContext({ view, disabled, act }: { view: McpControlView; disabled: boolean;
  act(type: string, fields?: Record<string, unknown>): Promise<boolean> }) {
  const [appId, setAppId] = useState(''), [profileRef, setProfile] = useState(''), [serverId, setServer] = useState('');
  const scope = () => ({ appId: appId.trim(), ...(profileRef.trim() ? { profileRef: profileRef.trim() } : {}) });
  return <details className="mcp-context"><summary>应用上下文与连接关联</summary>
    <p>手动提供应用标识和资料区，查找已登记的连接。此处不会自动读取当前窗口，也不会从标题猜测端口或程序。</p>
    <div className="mcp-form"><label>应用标识<input value={appId} onChange={e => setAppId(e.target.value)} disabled={disabled} /></label>
      <label>资料区标识（可选）<input value={profileRef} onChange={e => setProfile(e.target.value)} disabled={disabled} /></label>
      <button disabled={disabled || !appId.trim()} onClick={() => { void act('context', { context: scope() }); }}>查找关联连接</button>
      {view.context && <p>来源：手动选择 · {view.context.appId} · {view.context.profileRef ?? '无资料区'}<br />捕获时间：{new Date(view.context.capturedAt).toLocaleTimeString()}</p>}
      {view.resolution && <p role="status">{view.resolution.kind === 'selected' ? `匹配连接：${view.resolution.candidate.displayName}，请在连接卡片中选择用于本会话。`
        : view.resolution.kind === 'choice' ? `存在多个候选：${view.resolution.candidates.map(c => c.displayName).join('、')}，请明确选择。`
        : view.resolution.kind === 'unmatched' ? '没有关联连接。' : `上下文不可用：${view.resolution.reason}`}</p>}
      <label>关联到<select value={serverId} onChange={e => setServer(e.target.value)} disabled={disabled}>
        <option value="">选择已登记连接</option>{view.servers.map(s => <option key={s.config.serverId} value={s.config.serverId}>{s.config.displayName}</option>)}</select></label>
      <button disabled={disabled || !serverId || !appId.trim()} onClick={() => { const entry = view.servers.find(s => s.config.serverId === serverId); if (entry) void act('associate', { identity: entry.identity, scope: scope() }); }}>保存关联</button>
    </div>
    <ul>{view.associations.map(a => <li key={JSON.stringify(a)}>{a.appId} / {a.profileRef ?? '全部资料区'} → {a.serverId}
      <button disabled={disabled} onClick={() => { const entry = view.servers.find(s => s.config.serverId === a.serverId); if (entry) void act('dissociate', { identity: entry.identity, scope: { appId: a.appId, ...(a.profileRef ? { profileRef: a.profileRef } : {}) } }); }}>移除关联</button></li>)}</ul>
  </details>;
}
