export interface ReadingEntry {
  id: string;
  date: string;
  content: string;
  minutes: number;
  createdAt: string;
}

export type EntryInput = Pick<ReadingEntry, 'date' | 'content' | 'minutes'>;

export function today(): string {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function validateEntry(input: EntryInput): string | null {
  const parsed = new Date(`${input.date}T12:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date) || Number.isNaN(parsed.getTime()) ||
      parsed.toISOString().slice(0, 10) !== input.date) return '请选择有效的阅读日期。';
  if (!input.content.trim()) return '写下这次阅读的内容。';
  if (input.content.trim().length > 2000) return '阅读内容请控制在 2000 字以内。';
  if (!Number.isInteger(input.minutes) || input.minutes < 1 || input.minutes > 1440) {
    return '阅读时长请输入 1–1440 之间的整数。';
  }
  return null;
}

export function readEntry(id: string, value: unknown): ReadingEntry {
  if (!value || typeof value !== 'object') throw new Error('记录格式无法识别。');
  const entry = value as ReadingEntry;
  if (entry.id !== id || typeof entry.date !== 'string' || typeof entry.content !== 'string' ||
      typeof entry.createdAt !== 'string' || Number.isNaN(Date.parse(entry.createdAt)) || validateEntry(entry)) {
    throw new Error('已有记录格式无法识别，数据已保留。');
  }
  return entry;
}

export function sortEntries(entries: ReadingEntry[]): ReadingEntry[] {
  return [...entries].sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
}

export function summarize(entries: ReadingEntry[]) {
  return {
    count: entries.length,
    minutes: entries.reduce((total, entry) => total + entry.minutes, 0),
    days: new Set(entries.map(entry => entry.date)).size,
  };
}
