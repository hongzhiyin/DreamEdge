import type { CandidateBuild, VersionOperation } from '../shared/contracts';
import { CandidateBuildApi } from '../desktop/build/api';
import { compile } from '../desktop/build/compiler';
import { VersionsApi } from '../desktop/versions/api';
import type { SaveHook } from '../desktop/versions/transaction';
import { fixture } from './development-fixture';

export async function versionFixture(hook?: SaveHook, timeout = 30000) {
  const f = await fixture(async () => ({ summary: 'Update greeting and add module', files: [
    { path: 'main.ts', content: "document.body.textContent = 'Saved candidate';\n" },
    { path: 'components/greeting.ts', content: 'export const greeting = "Saved candidate";\n' },
  ] }));
  const builds = new CandidateBuildApi(f.workspace, input => compile(input), async () => {});
  const versions = new VersionsApi(f.workspace, f.profile, hook, timeout);
  await f.send(); const session = await f.settled();
  const build = await builds.execute({ operation: 'start', projectId: f.project.definition.id,
    candidate: { sessionId: session.id, turnId: session.turns[0].id } }) as CandidateBuild;
  while ((await builds.execute({ operation: 'get', projectId: f.project.definition.id, buildId: build.id }) as CandidateBuild).status === 'running') {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  async function settled(operation: VersionOperation, api = versions) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const result = await api.execute({ operation: 'getOperation', projectId: f.project.definition.id, operationId: operation.id }) as VersionOperation;
      if (result.status !== 'running') return result;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('Version operation did not finish');
  }
  return { ...f, versions, builds, build, settledVersion: settled,
    confirm: () => versions.execute({ operation: 'confirm', projectId: f.project.definition.id, buildId: build.id, label: 'Saved greeting' }) as Promise<VersionOperation>,
    cleanup: async () => { await versions.dispose(); await builds.dispose(); await f.cleanup(); } };
}
