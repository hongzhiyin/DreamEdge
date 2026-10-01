import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readEntry, sortEntries, summarize, validateEntry } from '../tools/reading-log/src/model';

test('real dates, nonempty content and whole minutes are required', () => {
  const valid = { date: '2024-02-29', content: '深入阅读', minutes: 30 };
  assert.equal(validateEntry(valid), null);
  assert.ok(validateEntry({ ...valid, date: '2025-02-29' }));
  assert.ok(validateEntry({ ...valid, content: '   ' }));
  for (const minutes of [0, 1441, 1.5, NaN]) assert.ok(validateEntry({ ...valid, minutes }));
});

test('statistics count reading days once and order records by reading date', () => {
  const entries = [
    { id: 'a', date: '2026-10-01', content: 'A', minutes: 20, createdAt: '2026-10-02T00:00:00Z' },
    { id: 'b', date: '2026-10-02', content: 'B', minutes: 30, createdAt: '2026-10-02T00:01:00Z' },
    { id: 'c', date: '2026-10-02', content: 'C', minutes: 15, createdAt: '2026-10-02T00:02:00Z' },
  ];
  assert.deepEqual(summarize(entries), { count: 3, minutes: 65, days: 2 });
  assert.deepEqual(sortEntries(entries).map(entry => entry.id), ['c', 'b', 'a']);
  assert.throws(() => readEntry('a', { ...entries[0], id: 'other' }));
});
