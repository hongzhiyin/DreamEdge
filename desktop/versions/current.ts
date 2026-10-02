import type { WorkspaceProject } from '../../shared/contracts';
import { DEFINITION_FILE, validateDefinition } from '../workspace/definition';
import { hash, readText } from '../workspace/paths';
import { readSourceTree, stateHash } from '../workspace/source-tree';

export async function currentVersionState(project: WorkspaceProject) {
  const raw = await readText(project.rootDirectory, DEFINITION_FILE);
  const definition = validateDefinition(JSON.parse(raw));
  if (JSON.stringify(definition) !== JSON.stringify(project.definition)) throw new Error('工程描述已变化，请重新打开工程。');
  const tree = await readSourceTree(project.sourceDirectory);
  const definitionHash = hash(JSON.stringify(definition));
  return { ...tree, definition, raw, definitionHash, stateHash: stateHash(definitionHash, tree.hashes) };
}
