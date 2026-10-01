import { useEffect, useState } from 'react';
import { storage } from '../../../tool-sdk/storage';
import { readEntry, sortEntries, validateEntry, type EntryInput, type ReadingEntry } from './model';

export function useEntries() {
  const [entries, setEntries] = useState<ReadingEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  async function load() {
    setLoading(true); setReady(false); setError('');
    try {
      const rows = await storage.list('entries');
      setEntries(sortEntries(rows.map(row => readEntry(row.id, row.value))));
      setReady(true);
    } catch (error) {
      setError(error instanceof Error ? error.message : '无法读取记录。');
    } finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []);

  async function add(input: EntryInput): Promise<boolean> {
    const invalid = validateEntry(input);
    if (invalid) { setError(invalid); return false; }
    setBusy(true); setError(''); setNotice('');
    const entry: ReadingEntry = { ...input, content: input.content.trim(), id: crypto.randomUUID(), createdAt: new Date().toISOString() };
    try {
      await storage.put('entries', entry.id, { ...entry });
      setEntries(current => sortEntries([...current, entry]));
      setNotice('记录已保存到本机。');
      return true;
    } catch (error) {
      setError(error instanceof Error ? error.message : '保存失败，请重试。');
      return false;
    } finally { setBusy(false); }
  }

  async function remove(id: string) {
    setBusy(true); setError(''); setNotice('');
    try {
      await storage.remove('entries', id);
      setEntries(current => current.filter(entry => entry.id !== id));
      setNotice('记录已删除。');
    } catch (error) {
      setError(error instanceof Error ? error.message : '删除失败，请重试。');
    } finally { setBusy(false); }
  }
  return { entries, loading, ready, busy, error, notice, add, remove, load };
}
