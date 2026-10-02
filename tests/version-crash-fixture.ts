import { WorkspaceApi } from '../desktop/workspace/api';
import { VersionsApi } from '../desktop/versions/api';
import type { VersionOperation } from '../shared/contracts';

const input = JSON.parse(process.argv[2]);
const workspace = new WorkspaceApi(input.profile, input.framework);
const versions = new VersionsApi(workspace, input.profile, async phase => {
  if (phase === input.phase) process.exit(42);
});
async function main() {
  const operation = await versions.execute({ operation: 'confirm', projectId: input.projectId, buildId: input.buildId, label: 'Crash fixture' }) as VersionOperation;
  while (true) {
    const result = await versions.execute({ operation: 'getOperation', projectId: input.projectId, operationId: operation.id }) as VersionOperation;
    if (result.status !== 'running') throw new Error(`Fixture did not reach crash phase: ${JSON.stringify(result)}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
void main().catch(error => { process.stderr.write(String(error)); process.exit(1); });
