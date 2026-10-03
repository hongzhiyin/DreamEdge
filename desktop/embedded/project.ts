import { randomUUID } from 'node:crypto';
import { lstat, mkdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { AppManifest, WorkspaceProject } from '../../shared/contracts';
import { WorkspaceApi } from '../workspace/api';
import { validateDefinition, DEFINITION_FILE } from '../workspace/definition';
import { directory, ensureDirectory, inside, readText, writeText } from '../workspace/paths';
import { readSourceTree, writeSourceTree } from '../workspace/source-tree';
import { initializeGit } from '../git/repository';
import { seedDisplay } from './view';
import { installLockedArchives } from './dependencies';

/** Initialize an App-owned workspace once. Upgrades never replace its source or history. */
export async function prepareEmbeddedProject(root: string, profile: string, frameworkRoot: string, manifest: AppManifest): Promise<WorkspaceProject | undefined> {
  if (!manifest.development) return;
  const base = await directory(profile); const framework = await directory(frameworkRoot);
  if (inside(framework, base) || inside(base, framework)) throw new Error('开发工程的用户目录必须位于 App 外。');
  const seed = join(root, manifest.development.project);
  const definition = validateDefinition(JSON.parse(await readText(seed, DEFINITION_FILE)));
  if (definition.appId !== manifest.appId) throw new Error('开发版初始工程与应用标识不一致。');
  const source = await readSourceTree(join(seed, 'src')); const target = join(base, 'project');
  try { await lstat(target); await directory(target); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const staging = await ensureDirectory(base, `.project-init-${randomUUID()}`);
    try {
      await mkdir(join(staging, 'src')); await writeSourceTree(join(staging, 'src'), source.files);
      await writeText(staging, DEFINITION_FILE, JSON.stringify(definition, null, 2));
      await initializeGit(staging); await rename(staging, target);
    } finally { await rm(staging, { recursive: true, force: true }); }
  }
  const local = validateDefinition(JSON.parse(await readText(target, DEFINITION_FILE)));
  if (local.appId !== manifest.appId) throw new Error('现有工程的应用标识已变化；源码保留，请修复工程描述。');
  const workspace = new WorkspaceApi(base, framework, undefined, { rootDirectory: target, appId: manifest.appId, projectId: local.id });
  const project = await workspace.execute({ operation: 'open', directory: target }) as WorkspaceProject;
  if (JSON.stringify(local.dependencyLock) === JSON.stringify(definition.dependencyLock)) await installLockedArchives(join(seed, 'dependencies'), project);
  await seedDisplay(root, manifest, project, definition, source);
  return project;
}
