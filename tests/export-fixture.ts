import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkspaceApi } from '../desktop/workspace/api';
import { CandidateBuildApi } from '../desktop/build/api';
import { compile } from '../desktop/build/compiler';
import { ProjectExports } from '../desktop/export/api';
import type { ExportEngine } from '../desktop/export/types';
import type { ProjectExport, WorkspaceProject } from '../shared/contracts';

export async function exportFixture(engine: ExportEngine = async ({ root }) => { await mkdir(join(root, 'deliverable', 'Fixture.app')); await writeFile(join(root, 'deliverable', 'Fixture.zip'), 'fixture'); }) {
  const root = await mkdtemp(join(tmpdir(), 'dreamedge-export-unit-')); const profile = join(root, 'profile'); const framework = join(root, 'framework');
  await mkdir(profile); await mkdir(framework); const runtime = join(framework, 'runtime'); const bundles = join(framework, 'bundles');
  await mkdir(join(runtime, 'shell'), { recursive: true }); await mkdir(bundles);
  for (const file of ['runtime.cjs', 'preload.cjs', 'build-worker.cjs', 'export-worker.cjs', 'THIRD_PARTY_NOTICES.txt']) await writeFile(join(runtime, file), 'trusted runtime');
  for (const name of ['sdk', 'desktop', 'cli']) await writeFile(join(bundles, `dreamedge-${name}-0.1.1.tgz`), `framework-${name}`);
  const resources = { runtime, bundles, frameworkVersion: '0.1.1', frameworkAppId: 'io.github.hongzhiyin.dreamedge' };
  const workspace = new WorkspaceApi(profile, framework); const project = await workspace.execute({ operation: 'create', name: 'Fixture', directory: join(root, 'project') }) as WorkspaceProject;
  const builds = new CandidateBuildApi(workspace, input => compile(input), async () => {});
  const exports = new ProjectExports(workspace, profile, framework, resources, builds, engine, true, async work => { await mkdir(join(work, 'tooling')); await writeFile(join(work, 'tooling/package.json'), '{}'); });
  async function settled(id: string) {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const record = await exports.execute({ operation: 'get', projectId: project.definition.id, exportId: id }) as ProjectExport;
      if (record.status !== 'running') return record; await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('Export did not settle');
  }
  return { root, profile, framework, resources, workspace, project, builds, exports, settled,
    cleanup: async () => { await exports.dispose(); await builds.dispose(); await rm(root, { recursive: true, force: true }); } };
}
