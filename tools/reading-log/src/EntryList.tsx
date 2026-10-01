import { useState } from 'react';
import { BookOpen, Trash2 } from 'lucide-react';
import type { ReadingEntry } from './model';

export function EntryList({ entries, loading, busy, onRemove }: {
  entries: ReadingEntry[]; loading: boolean; busy: boolean; onRemove(id: string): Promise<void>;
}) {
  const [confirm, setConfirm] = useState<string | null>(null);
  return <section className="history" aria-labelledby="history-title">
    <div className="section-heading"><h2 id="history-title">阅读足迹 <span className="count-badge">{entries.length}</span></h2><span>按阅读日期排列</span></div>
    {loading ? <p className="empty" role="status">正在读取本地记录…</p> : entries.length === 0 ? <div className="empty">
      <BookOpen size={29} /><h3>你的第一条阅读足迹</h3><p>记下今天读了什么，让每一页都有回响。</p>
    </div> : <ul className="entry-list">{entries.map(entry => <li className="entry" key={entry.id}>
      <div className="entry-date"><strong>{entry.date.slice(8)}</strong><span>{entry.date.slice(0, 7).replace('-', ' / ')}</span></div>
      <div className="entry-content"><p>{entry.content}</p><span className="duration">{entry.minutes} 分钟</span></div>
      {confirm === entry.id ? <div className="delete-confirm"><span>删除这条记录？</span>
        <button disabled={busy} className="danger-button" onClick={async () => { await onRemove(entry.id); setConfirm(null); }}>确认删除</button>
        <button disabled={busy} onClick={() => setConfirm(null)}>取消</button>
      </div> : <button className="delete-button" disabled={busy} aria-label={`删除记录：${entry.content}`} onClick={() => setConfirm(entry.id)}><Trash2 size={16} /></button>}
    </li>)}</ul>}
  </section>;
}
