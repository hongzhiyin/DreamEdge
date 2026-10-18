import { useState } from 'react';

function readDrafts(): Record<string, string> {
  try {
    const data: unknown = JSON.parse(sessionStorage.getItem('dreamedge:drafts') ?? '{}');
    if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
    return Object.fromEntries(Object.entries(data).filter(([, value]) => typeof value === 'string'));
  } catch { return {}; }
}

export function useDrafts() {
  const [drafts, setDrafts] = useState(readDrafts);
  function update(id: string, value: string, expected?: string): void {
    setDrafts(previous => {
      if (expected !== undefined && previous[id] !== expected) return previous;
      const next = { ...previous, [id]: value };
      try { sessionStorage.setItem('dreamedge:drafts', JSON.stringify(next)); } catch { /* Keep drafts in memory. */ }
      return next;
    });
  }
  return { drafts, update };
}
