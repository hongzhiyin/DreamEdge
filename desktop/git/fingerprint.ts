import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readlink } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { inside } from '../workspace/paths';

export async function changedFilesFingerprint(root: string, paths: string[]): Promise<string> {
  const fingerprint = createHash('sha256');
  for (const path of paths) {
    const file = resolve(root, path);
    if (!inside(root, file)) throw new Error('Git 文件路径超出工程仓库。');
    fingerprint.update(JSON.stringify(path));
    try {
      let parent = root; let blocked = false;
      for (const part of relative(root, file).split(sep).slice(0, -1)) {
        parent = join(parent, part); const info = await lstat(parent);
        if (!info.isDirectory() || info.isSymbolicLink()) { blocked = true; break; }
      }
      if (blocked) { fingerprint.update('blocked-parent'); continue; }
      const info = await lstat(file);
      fingerprint.update(`${info.mode}:`);
      if (info.isSymbolicLink()) fingerprint.update(await readlink(file));
      else if (info.isFile()) {
        const content = createHash('sha256');
        const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
        try { for await (const chunk of handle.createReadStream({ autoClose: false })) content.update(chunk); }
        finally { await handle.close(); }
        fingerprint.update(content.digest());
      } else fingerprint.update(`${info.mtimeMs}:${info.size}`);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; fingerprint.update('missing'); }
  }
  return fingerprint.digest('hex');
}
