import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SavedProjectDisplay } from '../desktop/display/current';
import { compile } from '../desktop/build/compiler';
import { Capacity } from '../desktop/windows/capacity';
import { fixture, deferred, proposal } from './development-fixture';
import type { BuildOutput } from '../desktop/build/types';

async function ready(display: SavedProjectDisplay) {
  const deadline = Date.now() + 4000;
  while (display.status?.status === 'loading' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(display.status?.status, 'ready', display.status?.error ?? 'Display timed out');
}
test('saved project display compiles source, uses checksummed cache and rebuilds after edits or corrupted output', async () => {
  const f = await fixture(async () => proposal); let builds = 0;
  const display = new SavedProjectDisplay(f.workspace, async input => { builds++; return compile(input); }, new Capacity(2, 'Busy'), () => {});
  try {
    display.refresh(); await ready(display); assert.equal(builds, 1);
    const url = `dreamedge://p${f.project.definition.id.replaceAll('-', '')}/${display.entry}`;
    const html = await display.serve(url); assert.equal(html.status, 200); assert.match(await html.text(), /module0.js/);
    assert.match(html.headers.get('Content-Security-Policy')!, /frame-ancestors dreamedge:\/\/shell/);
    assert.equal((await display.serve(url.replace('index.html', 'record.json'))).status, 404);
    assert.equal((await display.serve(url.replace(`p${f.project.definition.id.replaceAll('-', '')}`, 'other'))).status, 404);
    display.refresh(); await ready(display); assert.equal(builds, 1);
    const id = display.entry!.split('/')[1];
    await writeFile(join(f.project.buildDirectory, '.saved-view', id, 'output/index.html'), 'tampered');
    display.refresh(); await ready(display); assert.equal(builds, 2);
    await writeFile(join(f.project.sourceDirectory, 'main.ts'), "document.body.textContent='Saved edit';");
    display.refresh(); await ready(display); assert.equal(builds, 3);
    const body = await display.serve(`dreamedge://p${f.project.definition.id.replaceAll('-', '')}/${display.entry!.replace('index.html', '__dreamedge_bundle/module0.js')}`);
    assert.match(await body.text(), /Saved edit/);
  } finally { await display.dispose(); await f.cleanup(); }
});
test('a late display build cannot replace a newly selected project', async () => {
  const f = await fixture(async () => proposal); const output = deferred<BuildOutput>(); let calls = 0;
  const display = new SavedProjectDisplay(f.workspace, async input => ++calls === 1 ? output.promise : compile(input), new Capacity(2, 'Busy'), () => {});
  try {
    display.refresh(); while (!calls) await new Promise(resolve => setTimeout(resolve, 10));
    const other = await f.workspace.execute({ operation: 'create', directory: join(f.root, 'other'), name: 'Other' }) as { definition: { id: string } };
    display.refresh(); await ready(display); const entry = display.entry;
    output.resolve({ files: { 'index.html': 'Old project' }, logs: [] }); await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(display.entry, entry);
    const response = await display.serve(`dreamedge://p${other.definition.id.replaceAll('-', '')}/${entry}`);
    assert.equal(response.status, 200); assert.ok(!(await response.text()).includes('Old project'));
  } finally { output.resolve({ files: { 'index.html': 'Old project' }, logs: [] }); await display.dispose(); await f.cleanup(); }
});
test('display build failures show an error and recover on a retry without editing source', async () => {
  const f = await fixture(async () => proposal);
  const display = new SavedProjectDisplay(f.workspace, input => compile(input), new Capacity(1, 'Busy'), () => {});
  try {
    await writeFile(join(f.project.sourceDirectory, 'main.ts'), 'const broken: = ;'); display.refresh();
    const deadline = Date.now() + 4000;
    while (display.status?.status === 'loading' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(display.status?.status, 'failed'); assert.ok(display.status?.error); assert.equal(display.entry, undefined);
    await writeFile(join(f.project.sourceDirectory, 'main.ts'), "document.body.textContent='Recovered';"); display.refresh(); await ready(display);
  } finally { await display.dispose(); await f.cleanup(); }
});
