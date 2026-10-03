import { chmod, mkdir, readFile, readdir, readlink, lstat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Read installed ASAR resources through Electron's supported file APIs. */
export async function copyResource(source: string, target: string, skipNodeModules = false): Promise<void> {
  const stat = await lstat(source);
  if (stat.isSymbolicLink()) { await symlink(await readlink(source), target); return; }
  if (stat.isDirectory()) {
    await mkdir(target, { recursive: true });
    for (const name of await readdir(source)) if (!skipNodeModules || name !== 'node_modules') await copyResource(join(source, name), join(target, name), skipNodeModules);
    return;
  }
  if (!stat.isFile()) throw new Error('框架资源类型不受支持。');
  const unpacked = source.replace(/\.asar([/\\])/, '.asar.unpacked$1');
  const physical = unpacked !== source ? await lstat(unpacked).catch(error => {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return undefined; throw error;
  }) : undefined;
  // Virtual ASAR stats omit executable bits; native tools retain the real unpacked mode.
  const mode = physical?.isFile() && !physical.isSymbolicLink() ? physical.mode : stat.mode;
  await writeFile(target, await readFile(source)); await chmod(target, mode & 0o777);
}
