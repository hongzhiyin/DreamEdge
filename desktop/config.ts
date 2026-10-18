import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createCredentialResolver, parseModelConnection } from '../src/index.js';

export async function desktopConfig(root: string, options: {
  userData: string; packaged: boolean; environment?: NodeJS.ProcessEnv;
}) {
  const environment = options.environment ?? process.env;
  const path = environment.DREAMEDGE_CONFIG_FILE ?? (options.packaged
    ? join(options.userData, 'connection.local.json') : join(root, 'config/deepseek.example.json'));
  const credentialsFile = environment.DREAMEDGE_CREDENTIALS_FILE ?? (options.packaged
    ? join(options.userData, 'credentials.local.json') : join(root, 'config/credentials.local.json'));
  if (options.packaged) {
    await mkdir(options.userData, { recursive: true, mode: 0o700 });
    if (!environment.DREAMEDGE_CONFIG_FILE) await seed(join(root, 'config/deepseek.example.json'), path);
    if (!environment.DREAMEDGE_CREDENTIALS_FILE) await seed(join(root, 'config/credentials.example.json'), credentialsFile);
  }
  const config = parseModelConnection(JSON.parse(await readFile(path, 'utf8')));
  const credentials = createCredentialResolver({ credentialsFile });
  return { config, credentials };
}

async function seed(source: string, target: string): Promise<void> {
  try { await writeFile(target, await readFile(source), { flag: 'wx', mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
}
