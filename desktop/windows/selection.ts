import type { WorkspaceProject } from '../../shared/contracts';
import { WorkspaceRegistry, type WorkspaceSelection } from '../workspace/registry';
import { WindowState } from './state';

export function windowSelection(id: string, windows: WindowState, catalog: WorkspaceRegistry,
  changed: (project: WorkspaceProject | null) => void): WorkspaceSelection {
  return {
    load: async () => { await catalog.ready; return (await windows.record(id)).project; },
    assertIdentity: project => catalog.assertIdentity(project),
    select: async project => {
      if (project) await catalog.register(project);
      await windows.bind(id, project); changed(project);
    },
  };
}
