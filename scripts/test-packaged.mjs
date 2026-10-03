import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const paths = {
  darwin: `release/${process.arch === 'arm64' ? 'mac-arm64' : 'mac'}/DreamEdge.app/Contents/MacOS/DreamEdge`,
  win32: 'release/win-unpacked/DreamEdge.exe',
};
const relativePath = paths[process.platform];
if (!relativePath) throw new Error('此打包验收只支持 macOS 与 Windows。');
const executable = resolve(process.env.DREAMEDGE_EXECUTABLE_PATH || relativePath);
await access(executable);
for (const test of ['tests/desktop.e2e.mjs', 'tests/multi-window.e2e.mjs', 'tests/project-menu.e2e.mjs', 'tests/sidebar.e2e.mjs', 'tests/dependency-sidebar.e2e.mjs', 'tests/ai-sidebar.e2e.mjs', 'tests/chat-layout.e2e.mjs', 'tests/ai-structure.e2e.mjs', 'tests/timeline.e2e.mjs', 'tests/chat-markdown.e2e.mjs', 'tests/git-sidebar.e2e.mjs', 'tests/project-root-ai.e2e.mjs', 'tests/agent-git.e2e.mjs', 'tests/export-app.e2e.mjs']) {
  const args = ['tests/dependency-sidebar.e2e.mjs', 'tests/chat-layout.e2e.mjs', 'tests/ai-structure.e2e.mjs', 'tests/chat-markdown.e2e.mjs'].includes(test) ? ['--import', 'tsx', test] : [test];
  const result = spawnSync(process.execPath, args, { stdio: 'inherit', env: { ...process.env, DREAMEDGE_EXECUTABLE_PATH: executable } });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
