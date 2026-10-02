import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const paths = {
  darwin: `release/${process.arch === 'arm64' ? 'mac-arm64' : 'mac'}/DreamEdge.app/Contents/MacOS/DreamEdge`,
  win32: 'release/win-unpacked/DreamEdge.exe',
};
const relativePath = paths[process.platform];
if (!relativePath) throw new Error('此打包验收只支持 macOS 与 Windows。');
const executable = resolve(relativePath);
await access(executable);
for (const test of ['tests/desktop.e2e.mjs', 'tests/multi-window.e2e.mjs', 'tests/project-menu.e2e.mjs', 'tests/sidebar.e2e.mjs']) {
  const result = spawnSync(process.execPath, [test], { stdio: 'inherit', env: { ...process.env, DREAMEDGE_EXECUTABLE_PATH: executable } });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
