import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AppManifest, ProjectDefinition, WorkspaceProject } from '../../shared/contracts';
import { readText, listSource, hash } from '../workspace/paths';
import { equalHashes, readSourceTree, type SourceTree } from '../workspace/source-tree';
import { DisplayStore } from '../display/store';

export async function seedDisplay(root: string, manifest: AppManifest, project: WorkspaceProject, definition: ProjectDefinition, source: SourceTree): Promise<void> {
  const current = await readSourceTree(project.sourceDirectory);
  const build = (value: ProjectDefinition) => JSON.stringify({ dependencies: value.dependencies, lock: value.dependencyLock, build: value.build });
  if (!equalHashes(current.hashes, source.hashes) || build(project.definition) !== build(definition)) return;
  const directory = join(root, 'dist/tools', manifest.id); const paths = await listSource(directory);
  if (paths.length > 300) throw new Error('开发版产物超过数量限制。');
  const files: Record<string, string> = {};
  for (const path of paths) files[path] = await readText(directory, path);
  const store = new DisplayStore();
  const record = await store.publish(project, randomUUID(), hash(JSON.stringify(project.definition)), current.hashes, { files, logs: [] });
  await store.activate(project, record);
}
