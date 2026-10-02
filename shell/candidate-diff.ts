export interface DiffLine { kind: 'same' | 'removed' | 'added'; text: string }
export function candidateDiff(before: string | null, after: string): DiffLine[] {
  const original = before === null ? [] : before.split('\n'); const next = after.split('\n');
  let prefix = 0; let suffix = 0;
  while (prefix < original.length && prefix < next.length && original[prefix] === next[prefix]) prefix++;
  while (suffix < original.length - prefix && suffix < next.length - prefix && original[original.length - 1 - suffix] === next[next.length - 1 - suffix]) suffix++;
  if (prefix === original.length && prefix === next.length) return [];
  const same = (text: string): DiffLine => ({ kind: 'same', text });
  return [...original.slice(Math.max(0, prefix - 3), prefix).map(same),
    ...original.slice(prefix, original.length - suffix).map(text => ({ kind: 'removed' as const, text })),
    ...next.slice(prefix, next.length - suffix).map(text => ({ kind: 'added' as const, text })),
    ...original.slice(original.length - suffix, original.length - suffix + 3).map(same)];
}
