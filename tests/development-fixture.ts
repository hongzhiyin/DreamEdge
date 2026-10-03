import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DevelopmentSession, WorkspaceProject } from '../shared/contracts';
import { DevelopmentApi } from '../desktop/development/api';
import type { ModelInput, ModelProvider } from '../desktop/development/model';
import { WorkspaceApi } from '../desktop/workspace/api';

export async function fixture(generate: (input: ModelInput, signal: AbortSignal) => Promise<unknown>, timeout = 5000) {
  const root = await mkdtemp(join(tmpdir(), 'dreamedge-development-'));
  const profile = join(root, 'profile'); const framework = join(root, 'framework');
  await mkdir(profile); await mkdir(framework);
  const workspace = new WorkspaceApi(profile, framework);
  const provider: ModelProvider = { connection: async () => ({ provider: 'test', available: true, detail: 'Fixture' }), generate };
  const api = new DevelopmentApi(workspace, provider, timeout);
  const project = await workspace.execute({ operation: 'create', directory: join(root, 'project'), name: 'HelloWorld' }) as WorkspaceProject;
  const session = await api.execute({ operation: 'create', projectId: project.definition.id, title: 'Test session' }) as DevelopmentSession;
  const get = () => api.execute({ operation: 'get', projectId: project.definition.id, sessionId: session.id }) as Promise<DevelopmentSession>;
  const send = (prompt = 'Change the greeting', paths = ['src/main.ts']) => api.execute({ operation: 'send', projectId: project.definition.id, sessionId: session.id, prompt, paths });
  async function settled() {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const value = await get();
      if (value.turns.at(-1)?.status !== 'running') return value;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('Development fixture did not settle');
  }
  return { root, profile, framework, workspace, api, provider, project, session, get, send, settled,
    cleanup: async () => { await api.dispose(); await rm(root, { recursive: true, force: true }); } };
}
export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(complete => { resolve = complete; });
  return { promise, resolve };
}
export const proposal = { summary: 'Update greeting', files: [{ path: 'src/main.ts', content: "document.body.textContent = 'Updated';\n" }] };
