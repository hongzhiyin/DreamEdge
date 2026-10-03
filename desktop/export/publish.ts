import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const exec = promisify(execFile);
export async function publishExport(source: string, target: string) {
  if (process.platform === 'darwin') {
    // Native copy treats app.asar as a file and preserves signed framework symlinks.
    await exec('/usr/bin/ditto', [source, target], { maxBuffer: 1024 * 1024 });
    return;
  }
  for (const name of await readdir(source)) await cp(join(source, name), join(target, name), { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
}
