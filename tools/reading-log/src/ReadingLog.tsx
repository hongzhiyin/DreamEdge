import { BookOpen, CalendarDays, Clock3 } from 'lucide-react';
import { EntryForm } from './EntryForm';
import { EntryList } from './EntryList';
import { summarize } from './model';
import { useEntries } from './useEntries';
import type { StorageClient } from '../../../tool-sdk/storage-client';

export function ReadingLog({ store }: { store?: StorageClient } = {}) {
  const { entries, loading, ready, busy, error, notice, add, remove, load } = useEntries(store);
  const summary = summarize(entries);
  const stats = [
    { label: '阅读记录', value: summary.count, unit: '条', icon: BookOpen },
    { label: '累计专注', value: summary.minutes, unit: '分钟', icon: Clock3 },
    { label: '阅读天数', value: summary.days, unit: '天', icon: CalendarDays },
  ];
  return <div className="reading-page">
    <header className="page-heading"><div className="eyebrow">A LITTLE READING, EVERY DAY</div>
      <h1>阅读记录<span>把读过的时光，留在这里。</span></h1>
      <p>不必读得很快。每一页，都是与自己相处的时间。</p>
    </header>
    <div className="stats" aria-label="阅读统计">{stats.map(stat => <div className="stat" key={stat.label}>
      <div><span>{stat.label}</span><stat.icon size={17} /></div>
      <p><strong>{loading ? '—' : stat.value}</strong><span>{stat.unit}</span></p>
    </div>)}</div>
    {error && <div className="error-message" role="alert"><span>{error}</span><button disabled={busy || loading} onClick={() => void load()}>重新读取</button></div>}
    <EntryForm disabled={!ready || loading} busy={busy} onAdd={add} />
    <p className="save-status" role="status" aria-live="polite">{notice || '\u00a0'}</p>
    <EntryList entries={entries} loading={loading} busy={busy} onRemove={remove} />
    <footer className="page-footer"><span className="status-dot" />本地保存 · 无需模型即可使用<span>READ. REFLECT. REPEAT.</span></footer>
  </div>;
}
