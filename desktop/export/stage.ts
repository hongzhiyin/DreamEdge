import { randomUUID } from 'node:crypto';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import type { AppManifest } from '../../shared/contracts';
import { hash, relativeParts } from '../workspace/paths';
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
  const app = join(root, 'application'); const project = join(root, 'deliverable', '工程');
  await mkdir(join(app, 'dist', 'runtime'), { recursive: true }); await mkdir(join(project, '.dreamedge'), { recursive: true });
  await mkdir(join(project, 'src')); await writeSourceTree(join(project, 'src'), snapshot.files);
  const definition = { ...snapshot.definition, id: randomUUID(), savedAt: new Date().toISOString() };
  await writeFile(join(project, '.dreamedge/project.json'), JSON.stringify(definition, null, 2));
  await writeFile(join(project, '.gitignore'), '/.dreamedge/model.json\n/.dreamedge/transaction/\n');
  await mkdir(join(project, 'framework')); const framework: Record<string, string> = {};
  for (const name of ['desktop', 'sdk', 'cli']) {
    const file = `dreamedge-${name}-${resources.frameworkVersion}.tgz`;
    await copyResource(join(resources.bundles, file), join(project, 'framework', file)); framework[`@dreamedge/${name}`] = `file:framework/${file}`;
  }
  await writeFile(join(project, 'framework/dependencies.json'), JSON.stringify({ version: resources.frameworkVersion, dependencies: framework }, null, 2));
  await writeFile(join(project, 'README.md'), '在 DreamEdge 中打开本目录可继续开发。src 为业务源码，framework 为导出时使用的框架包快照。模型连接、会话、Git 历史和业务数据未复制。\n');
  await copyResource(join(resources.runtime, 'shell'), join(app, 'dist', 'shell'));
  for (const file of ['runtime.cjs', 'preload.cjs', 'build-worker.cjs', 'THIRD_PARTY_NOTICES.txt']) await copyResource(join(resources.runtime, file), join(app, 'dist', 'runtime', file));
  const output = join(app, 'dist', 'tools', manifest.id); await mkdir(output, { recursive: true }); await writeSourceTree(output, snapshot.outputs);
  await writeFile(join(app, 'dist/app.json'), JSON.stringify(manifest, null, 2));
  await writeFile(join(app, 'dist/main.cjs'), "require('./runtime/runtime.cjs').startApp();\n");
  await writeFile(join(app, 'package.json'), JSON.stringify({ name: manifest.id, version: manifest.version, productName: manifest.name,
    description: manifest.description, author: 'DreamEdge app author', private: true, main: 'dist/main.cjs', dependencies: { esbuild: '0.28.2' } }, null, 2));
  const require = createRequire(__filename); const esbuildRequire = createRequire(require.resolve('esbuild'));
  for (const name of ['esbuild', `@esbuild/${process.platform}-${process.arch}`]) {
    const source = name === 'esbuild' ? require.resolve('esbuild/package.json') : esbuildRequire.resolve(`${name}/package.json`);
    const target = join(app, 'node_modules', name); await mkdir(join(target, '..'), { recursive: true });
    await copyResource(join(source, '..'), target);
  }
  await writeFile(join(root, 'deliverable', 'export.json'), JSON.stringify({ application: manifest.name, appId: manifest.appId, version: manifest.version,
    frameworkVersion: resources.frameworkVersion, sourceProjectId: snapshot.definition.id, exportedProjectId: definition.id, project: '工程', platform: process.platform, arch: process.arch }, null, 2));
  return manifest;
}
