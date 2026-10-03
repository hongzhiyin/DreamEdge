import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DevelopmentSession, ModelProposal } from '../shared/contracts';
import { DevelopmentApi } from '../desktop/development/api';
import { AutomaticEdits } from '../desktop/development/apply';
import { CandidateBuildApi } from '../desktop/build/api';
import { compile } from '../desktop/build/compiler';
import { dependencyPreparer, type DependencyPreparer } from '../desktop/dependencies/prepare';
import { commitGit } from '../desktop/git/repository';
import { fixture } from './development-fixture';
import { packageRegistry } from './dependency-fixture';

export const structureProposal: ModelProposal = { summary: 'Use dependency and remove unused source', files: [
  { path: 'main.ts', content: "import { greeting } from 'dreamedge-greeting';document.getElementById('root')!.textContent=greeting;" },
  { path: 'unused.ts', content: null },
] };
export async function structureFixture(automatic = true, prepare?: DependencyPreparer) {
  const f = await fixture(async () => structureProposal);
  const registry = await packageRegistry();
  const item = await registry.add('dreamedge-greeting', '1.0.0', { 'index.js': "export const greeting='Hello Structure';" });
  await writeFile(join(f.project.sourceDirectory, 'unused.ts'), "export const unused='old';");
  const baseline = (await commitGit(f.project.rootDirectory, 'Before structure changes'))!;
  const builds = new CandidateBuildApi(f.workspace, input => compile(input), async () => {}, 5000, undefined, prepare ?? dependencyPreparer(registry.registry));
  const api = new DevelopmentApi(f.workspace, f.provider, 5000, automatic ? new AutomaticEdits(f.workspace, f.profile, builds, () => {}) : undefined);
  async function settled() {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const value = await api.execute({ operation: 'get', projectId: f.project.definition.id, sessionId: f.session.id }) as DevelopmentSession;
      if (value.turns.at(-1)?.status !== 'running') return value.turns.at(-1)!;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('Structure edit did not settle');
  }
  const send = (commit = false) => api.execute({ operation: 'send', projectId: f.project.definition.id, sessionId: f.session.id,
    prompt: 'Use greeting package and delete unused file', paths: ['main.ts', 'unused.ts'], commit });
  return { ...f, api, builds, registry, item, baseline, send, settled,
    cleanup: async () => { await api.dispose(); await builds.dispose(); await f.cleanup(); } };
}
