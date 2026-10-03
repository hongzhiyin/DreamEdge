import assert from 'node:assert/strict';
import { access, readFile, readdir, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
/** Called only with test-owned destination paths, after the running App has closed. */
export async function replaceApp(source, installed) {
  assert.ok(source.endsWith('.app') && installed.endsWith('.app') && source !== installed);
  await rm(installed, { recursive: true, force: true });
  await execute('/usr/bin/ditto', [source, installed]);
  await execute('/usr/bin/codesign', ['--verify', '--deep', '--strict', installed]);
}
export async function exportProject(framework, page, project, output) {
  const panel = page.getByRole('region', { name: '应用与导出' });
  await framework.evaluate(({ dialog }, { output, appName }) => { dialog.showSaveDialog = async (_parent, options) => {
    if (options.defaultPath !== `${appName}-导出` || options.buttonLabel !== '导出') throw new Error('Wrong export dialog');
    return { canceled: false, filePath: output };
  }; }, { output, appName: project.definition.appName ?? project.definition.name });
  const previous = (await page.evaluate(projectId => window.dreamEdge.exportApp({ operation: 'current', projectId }), project.definition.id)).record?.id;
  await panel.getByRole('button', { name: '导出 macOS App' }).click();
  const deadline = Date.now() + 180000; let record;
  while (Date.now() < deadline) {
    record = (await page.evaluate(projectId => window.dreamEdge.exportApp({ operation: 'current', projectId }), project.definition.id)).record;
    if (record && record.id !== previous && record.status !== 'running') break;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert.notEqual(record?.id, previous, 'No new export started');
  assert.equal(record?.status, 'succeeded', record?.error ?? 'Export timed out');
  await panel.getByText('业务 App 已导出。', { exact: true }).waitFor();
  const files = await readdir(output); const app = files.find(name => name.endsWith('.app'));
  assert.equal(app, `${project.definition.appName}.app`); assert.ok(files.some(name => name.endsWith('.zip')));
  const descriptor = JSON.parse(await readFile(join(output, '工程/.dreamedge/project.json'), 'utf8'));
  assert.notEqual(descriptor.id, project.definition.id);
  for (const field of ['name', 'appName', 'appId', 'version']) assert.equal(descriptor[field], project.definition[field]);
  for (const file of ['.dreamedge/model.json', '.git', 'data', 'sessions']) await assert.rejects(access(join(output, '工程', file)));
  const asar = createRequire(import.meta.url)('@electron/asar'); const archive = join(output, app, 'Contents/Resources/app.asar');
  assert.ok(!asar.listPackage(archive).some(path => /model\.json|records\.sqlite|session\.json/.test(path)));
  const manifest = JSON.parse(asar.extractFile(archive, 'dist/app.json').toString());
  assert.equal(manifest.version, project.definition.version); assert.equal(manifest.appId, project.definition.appId);
  assert.ok(!JSON.stringify(manifest).includes('fixture-export-secret'));
  await execute('/usr/bin/codesign', ['--verify', '--deep', '--strict', join(output, app)]);
  return join(output, app);
}
export const appExecutable = path => join(path, 'Contents/MacOS', basename(path, '.app'));
