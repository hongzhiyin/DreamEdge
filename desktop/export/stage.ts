import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AppManifest } from '../../shared/contracts';
import { hash } from '../workspace/paths';
import { writeSourceTree } from '../workspace/source-tree';
import { applicationName } from '../workspace/definition';
import { copyResource } from './resources';
import type { ExportResources, ExportSnapshot } from './types';

export function exportedManifest(snapshot: ExportSnapshot): AppManifest {
  const { version, appId } = snapshot.definition;
  const name = applicationName(snapshot.definition.appName ?? snapshot.definition.name);
  return { id: 'a' + hash(appId).slice(0, 31), name, version, appId, description: '使用 DreamEdge 开发的独立应用',
    renderer: 'src', entry: 'index.html', capabilities: ['storage'] };
}
export async function stageExport(root: string, snapshot: ExportSnapshot, resources: ExportResources): Promise<AppManifest> {
  const manifest = exportedManifest(snapshot);
  if (manifest.appId === resources.frameworkAppId) throw new Error('业务 App 标识不能与 DreamEdge 开发框架相同。');
  const app = join(root, 'application'); await mkdir(join(root, 'deliverable'), { recursive: true });
  await copyResource(join(resources.runtime, 'business-shell'), join(app, 'dist/shell'));
  await mkdir(join(app, 'dist/runtime'));
  for (const file of ['business-runtime.cjs', 'preload.cjs', 'THIRD_PARTY_NOTICES.txt']) await copyResource(join(resources.runtime, file), join(app, 'dist/runtime', file));
  const output = join(app, 'dist/tools', manifest.id); await mkdir(output, { recursive: true }); await writeSourceTree(output, snapshot.outputs);
  await writeFile(join(app, 'dist/app.json'), JSON.stringify(manifest, null, 2));
  await writeFile(join(app, 'dist/main.cjs'), "require('./runtime/business-runtime.cjs').startBusinessApp();\n");
  await writeFile(join(app, 'package.json'), JSON.stringify({ name: manifest.id, version: manifest.version, productName: manifest.name,
    description: manifest.description, author: 'DreamEdge app author', private: true, main: 'dist/main.cjs' }, null, 2));
  return manifest;
}
