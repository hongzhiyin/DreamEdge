import type { GitCommit } from '../shared/contracts';

export interface GraphEdge { from: number; to: number; start: 'top' | 'node'; continuation: boolean }
export interface GraphRow { column: number; incoming: boolean; edges: GraphEdge[] }
export function commitGraph(commits: GitCommit[]): { rows: GraphRow[]; width: number } {
  let lanes: string[] = []; let columns = 1;
  const rows = commits.map((commit, row) => {
    const incoming = lanes.includes(commit.id);
    if (!incoming) lanes.push(commit.id);
    const before = [...lanes]; const column = before.indexOf(commit.id);
    const parents = [...new Set(commit.parents ?? [])]; const after = before.filter(id => id !== commit.id);
    parents.forEach((id, index) => { if (!after.includes(id)) after.splice(index === 0 ? Math.min(column, after.length) : after.length, 0, id); });
    const visible = new Set(commits.slice(row + 1).map(item => item.id));
    const edges: GraphEdge[] = before.flatMap((id, from) => id === commit.id ? []
      : [{ from, to: after.indexOf(id), start: 'top' as const, continuation: !visible.has(id) }]);
    edges.push(...parents.map(id => ({ from: column, to: after.indexOf(id), start: 'node' as const, continuation: !visible.has(id) })));
    columns = Math.max(columns, before.length, after.length); lanes = after;
    return { column, incoming, edges };
  });
  return { rows, width: 20 + (columns - 1) * 14 };
}
