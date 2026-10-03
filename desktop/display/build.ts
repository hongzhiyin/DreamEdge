import { randomUUID } from 'node:crypto';
import type { WorkspaceProject } from '../../shared/contracts';
import { BuildStore, buildRoot } from '../build/store';
import { readText } from '../workspace/paths';
import { equalHashes } from '../workspace/source-tree';
import type { sourceSnapshot } from '../build/snapshot';
import { DisplayStore } from './store';
import { join } from 'node:path';

export async function reuseBuild(store: DisplayStore, project: WorkspaceProject, snapshot: Awaited<ReturnType<typeof sourceSnapshot>>, id: string) {
  const builds = new BuildStore(); const record = await builds.load(project, id);
  const definition = await builds.candidateDefinition(project, record);
  const stable = (value: typeof definition) => { const { savedAt: _time, ...rest } = value; return rest; };
  if (record.status !== 'succeeded' || !equalHashes(record.candidateHashes, snapshot.hashes)
    || JSON.stringify(stable(definition)) !== JSON.stringify(stable(project.definition))) return null;
  await builds.verify(project, record);
  const files: Record<string, string> = Object.create(null);
  for (const path of Object.keys(record.outputHashes)) files[path] = await readText(join(buildRoot(project, id), 'output'), path);
  return store.publish(project, randomUUID(), snapshot.definitionHash, snapshot.hashes, { files, logs: [] });
}
