import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const paths = {
  darwin: `release/${process.arch === 'arm64' ? 'mac-arm64' : 'mac'}/IdeaDock.app/Contents/MacOS/IdeaDock`,
  win32: 'release/win-unpacked/IdeaDock.exe',
};
const relativePath = paths[process.platform];
if (!relativePath) throw new Error('此打包验收只支持 macOS 与 Windows。');
const executable = resolve(relativePath);
await access(executable);
const result = spawnSync(process.execPath, ['tests/desktop.e2e.mjs'], {
  stdio: 'inherit',
  env: { ...process.env, IDEADOCK_EXECUTABLE_PATH: executable },
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
