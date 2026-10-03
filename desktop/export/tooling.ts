import { cp, mkdir, readFile, symlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { copyResource } from './resources';
import { hash } from '../workspace/paths';

/** Extract only the installed packing library graph; worker tools run outside ASAR. */
export async function prepareTooling(root: string, signal: AbortSignal) {
  const tooling = join(root, 'tooling'); const copied = new Map<string, string>();
  async function locate(name: string, require: NodeJS.Require) {
    try { return dirname(require.resolve(`${name}/package.json`)); } catch {}
    let folder = dirname(require.resolve(name));
    while (true) { try { if (JSON.parse(await readFile(join(folder, 'package.json'), 'utf8')).name === name) return folder; } catch {}
      const parent = dirname(folder); if (parent === folder) throw new Error('构建工具依赖位置无效。'); folder = parent; }
  }
  async function copy(name: string, require: NodeJS.Require): Promise<string> {
    signal.throwIfAborted(); const source = await locate(name, require); const existing = copied.get(source); if (existing) return existing;
    if (copied.size >= 300) throw new Error('构建工具依赖过多。');
    const target = join(tooling, 'packages', hash(source).slice(0, 24)); copied.set(source, target);
    await copyResource(source, target, true);
    const metadata = JSON.parse(await readFile(join(source, 'package.json'), 'utf8')); const childRequire = createRequire(join(source, 'package.json'));
    for (const dependency of Object.keys({ ...metadata.dependencies, ...metadata.optionalDependencies })) {
      let directory: string; try { directory = await copy(dependency, childRequire); }
      catch (error) { if (metadata.optionalDependencies?.[dependency] && (error as NodeJS.ErrnoException).code === 'MODULE_NOT_FOUND') continue; throw error; }
      const link = join(target, 'node_modules', dependency); await mkdir(dirname(link), { recursive: true }); await symlink(relative(dirname(link), directory), link);
    }
    return target;
  }
  const target = await copy('app-builder-lib', createRequire(__filename));
  await mkdir(join(tooling, 'node_modules'), { recursive: true }); await symlink(relative(join(tooling, 'node_modules'), target), join(tooling, 'node_modules/app-builder-lib'));
}
