import { readFileSync } from 'node:fs';
import { WorkspaceApi } from '../desktop/workspace/api';
import { currentVersionState } from '../desktop/changes/current';
import { applyState } from '../desktop/changes/apply';

const input = JSON.parse(readFileSync(0, 'utf8'));
const workspace = new WorkspaceApi(input.profile, input.framework);
void workspace.mutateProject(input.projectId, async project => {
  const state = await currentVersionState(project);
  await applyState(project, input.profile, { ...state.files, 'main.ts': "document.body.textContent='Crash edit';" }, state.definition,
    state.stateHash, new AbortController().signal, async phase => { if (phase === input.phase) process.kill(process.pid, 'SIGKILL'); });
});
