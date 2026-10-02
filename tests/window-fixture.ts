import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AppManifest, WorkspaceProject } from '../shared/contracts';
import { WorkspaceRegistry } from '../desktop/workspace/registry';
import { WindowState } from '../desktop/windows/state';
import { WindowContext } from '../desktop/windows/context';
import { Capacity } from '../desktop/windows/capacity';
import { compile } from '../desktop/build/compiler';
import type { ModelProvider } from '../desktop/development/model';

export async function windowFixture(provider: ModelProvider = { connection: async () => ({ provider: 'fixture', available: true, detail: 'Test' }),
  generate: async () => ({ summary: 'No changes', files: [] }) }) {
  const root = await mkdtemp(join(tmpdir(), 'dreamedge-windows-')); const profile = join(root, 'profile'); const framework = join(root, 'framework');
  await mkdir(profile); await mkdir(framework);
  const catalog = new WorkspaceRegistry(profile); const windows = new WindowState(profile);
  await Promise.all([catalog.ready, windows.ready]);
  const capacity = new Capacity(2, 'Global build limit'); const contexts: WindowContext[] = [];
  const manifest: AppManifest = { id: 'hello-world', appId: 'io.example.framework', name: 'DreamEdge', description: 'Fixture',
    version: '0.1.1', entry: 'index.html', renderer: 'ui', capabilities: ['workspace', 'storage'] };
  async function context(id?: string) {
    const record = id ? await windows.record(id) : await windows.allocate();
    const result = new WindowContext({ id: record.id, manifest, root: framework, profile, frameworkRoot: framework,
      catalog, windows, provider, engine: input => compile(input), buildCapacity: capacity,
      openPreview: async () => {}, changed: () => {}, closePreviews: () => {} });
    contexts.push(result); await result.ready(); return result;
  }
  const a = await context(); const b = await context();
  const [pa, pb] = await Promise.all([a.executeWorkspace({ operation: 'create', directory: join(root, 'A'), name: 'A' }),
    b.executeWorkspace({ operation: 'create', directory: join(root, 'B'), name: 'B' })]) as WorkspaceProject[];
  return { root, profile, framework, catalog, windows, a, b, pa, pb, context, manifest,
    cleanup: async () => { await Promise.all(contexts.map(context => context.dispose())); await rm(root, { recursive: true, force: true }); } };
}
