import type { WorkspaceProject } from '../../shared/contracts';
import { assertRepository, commitId, git } from './command';
import { validateDefinition } from '../workspace/definition';
import { relativeParts } from '../workspace/paths';
import { assertSnapshot } from '../build/snapshot';

export async function gitHistory(root: string, range?: string) {
  const text = await git(root, ['log', '-50', '--date-order', '--format=%H%x00%s%x00%cI%x00%P', ...(range ? [range] : [])]).catch(() => '');
  return text.trim().split('\n').filter(Boolean).map(line => {
    const [id, message, createdAt, parents] = line.split('\0'); return { id, message, createdAt, parents: parents ? parents.split(' ') : [] };
  });
}
export async function gitSnapshot(project: WorkspaceProject, id: string) {
  await assertRepository(project.rootDirectory); commitId(id);
  await git(project.rootDirectory, ['cat-file', '-e', `${id}^{commit}`]);
  const definition = validateDefinition(JSON.parse(await git(project.rootDirectory, ['show', `${id}:.dreamedge/project.json`])));
  if (definition.id !== project.definition.id) throw new Error('Git 历史内容不属于当前工程。');
  const entries = (await git(project.rootDirectory, ['ls-tree', '-r', '-z', id, '--', 'src'])).split('\0').filter(Boolean);
  if (entries.length > 200) throw new Error('Git 源码历史最多支持 200 个文件。');
  const files: Record<string, string> = Object.create(null);
  for (const entry of entries) {
    const [metadata, path] = entry.split('\t'); const [mode, type, object] = metadata.split(' ');
    if (!['100644', '100755'].includes(mode) || type !== 'blob' || !path.startsWith('src/')) throw new Error('历史包含非普通源码文件，拒绝恢复。');
    const name = path.slice(4); relativeParts(name); files[name] = await git(project.rootDirectory, ['cat-file', 'blob', object]);
    if (files[name].includes('\0')) throw new Error('历史源码不是 UTF-8 文本。');
    assertSnapshot({ files });
  }
  if (!Object.hasOwn(files, definition.build.entry)) throw new Error('Git 历史缺少工程入口。');
  return { files, definition };
}
