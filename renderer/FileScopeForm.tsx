import { useState } from 'react';
import { FolderPlus } from 'lucide-react';
import type { FileGrantOptions } from '../src/files/scope-types.js';

export function FileScopeForm({ disabled, busy, choose }: {
  disabled: boolean; busy: boolean; choose(options: FileGrantOptions): void;
}) {
  const [mode, setMode] = useState<FileGrantOptions['mode']>('read');
  const [remember, setRemember] = useState(false); const [duration, setDuration] = useState('0');
  const [excludes, setExcludes] = useState('');
  return <form className="scope-form" onSubmit={event => {
    event.preventDefault(); if (disabled || busy) return;
    const milliseconds = Number(duration);
    choose({ mode, remember, excludes: excludes.split('\n').map(line => line.trim()).filter(Boolean),
      ...(milliseconds ? { expiresAt: Date.now() + milliseconds } : {}) });
  }}>
    <div className="scope-fields">
      <label>目录权限<select aria-label="目录权限" value={mode} disabled={busy}
        onChange={event => setMode(event.target.value as FileGrantOptions['mode'])}>
        <option value="read">只读</option><option value="read-write">读写 · 每次变更仍需确认</option>
      </select></label>
      <label>授权期限<select aria-label="授权期限" value={duration} disabled={busy} onChange={event => setDuration(event.target.value)}>
        <option value="0">不设置到期时间</option><option value="3600000">1 小时</option><option value="86400000">24 小时</option>
      </select></label>
    </div>
    <label className="scope-check"><input type="checkbox" checked={remember} disabled={busy}
      onChange={event => setRemember(event.target.checked)} />重启后保留此授权</label>
    <details className="scope-exclusions"><summary>排除范围</summary>
      <p>默认排除 .git、.ssh、.codex、.env 和凭据文件。以下路径相对所选目录，每行一项，包含其子目录，不支持通配符。</p>
      <label>额外排除路径<textarea aria-label="额外排除路径" placeholder={'private\nnotes/personal'} value={excludes}
        disabled={busy} onChange={event => setExcludes(event.target.value)} /></label>
    </details>
    <p className="scope-help">授权仅限当前会话。临时授权在应用退出后失效；读写授权不代替变更预览和一次性确认。</p>
    <button className="scope-add" type="submit" disabled={disabled || busy}><FolderPlus size={16} />{busy ? '正在处理…' : '选择目录'}</button>
    {disabled && <p className="scope-help">目录选择暂不可用，请先完成保存或恢复连接。</p>}
  </form>;
}
