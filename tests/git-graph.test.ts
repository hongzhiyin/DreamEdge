import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commitGraph } from '../shell/gitGraph';
import { gitHistory } from '../desktop/git/history';
import { git } from '../desktop/git/command';
import { fixture, proposal } from './development-fixture';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const commit = (id: string, parents: string[] = []) => ({ id, parents, message: id, createdAt: '2026-10-03T00:00:00Z' });
test('commit graph routes a merge into two lanes that meet at the actual common parent', () => {
  const graph = commitGraph([commit('merge', ['main', 'feature']), commit('main', ['base']), commit('feature', ['base']), commit('base')]);
  assert.equal(graph.width, 34);
  assert.deepEqual(graph.rows.map(row => row.column), [0, 0, 1, 0]);
  assert.deepEqual(graph.rows[0].edges.map(edge => [edge.from, edge.to]), [[0, 0], [0, 1]]);
  assert.ok(graph.rows[2].edges.some(edge => edge.from === 1 && edge.to === 0));
  assert.equal(graph.rows.at(-1)!.edges.length, 0);
});
test('linear, truncated and missing-parent history never invents ancestry', () => {
  const linear = commitGraph([commit('new', ['old']), commit('old')]);
  assert.equal(linear.width, 20); assert.equal(linear.rows[1].incoming, true);
  assert.equal(commitGraph([commit('new', ['outside'])]).rows[0].edges[0].continuation, true);
  assert.equal(commitGraph([commit('unknown'), commit('another')]).rows[1].incoming, false);
  assert.deepEqual(commitGraph([]).rows, []);
});
test('real Git history returns merge parents in child-before-parent order', async () => {
  const f = await fixture(async () => proposal); const root = f.project.rootDirectory;
  try {
    await git(root, ['checkout', '-b', 'feature']); await writeFile(join(root, 'feature.txt'), 'Feature');
    await git(root, ['add', '--', 'feature.txt']); await git(root, ['commit', '-m', 'Feature']);
    await git(root, ['checkout', 'main']); await writeFile(join(root, 'main.txt'), 'Main');
    await git(root, ['add', '--', 'main.txt']); await git(root, ['commit', '-m', 'Main']);
    await git(root, ['merge', '--no-ff', '-m', 'Merge feature', 'feature']);
    const history = await gitHistory(root); assert.equal(history[0].parents.length, 2);
    const positions = new Map(history.map((item, index) => [item.id, index]));
    history.forEach((item, index) => item.parents.forEach(parent => assert.ok(!positions.has(parent) || positions.get(parent)! > index)));
    assert.equal(commitGraph(history).width, 34);
  } finally { await f.cleanup(); }
});
