import { mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
await mkdir('artifacts/framework', { recursive: true });
const command = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const result = spawnSync(command, ['pack', './packages/sdk', './packages/desktop', './packages/cli',
  '--pack-destination', 'artifacts/framework', '--cache', 'node_modules/.cache/dreamedge-pack'], { stdio: 'inherit', shell: process.platform === 'win32' });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
