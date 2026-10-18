import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { launchProtocol, parseLaunchRequest, LaunchError } from '../src/launch/protocol.js';
import { callControl, controlDirectory } from '../src/launch/socket.js';
import { launchDataDirectory } from '../src/launch/paths.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const packaged = root.includes('app.asar');
const command = packaged ? join(dirname(process.execPath), process.platform === 'win32' ? 'dreamedge-cli.exe' : 'dreamedge-cli') : process.execPath;
const prefix = packaged ? [] : [fileURLToPath(import.meta.url)];
async function main() {
  const operation = process.argv[2];
  if (process.argv.length !== 3) throw new LaunchError('INVALID_COMMAND', '用法：dreamedge-cli describe | open-session | status | revoke；请求 JSON 从 stdin 读取。');
  if (operation === 'describe') return { protocol: launchProtocol, name: 'DreamEdge',
    transport: { type: 'stdio', command, args: prefix },
    capabilities: { embeddedPage: true, resume: true, background: true, context: 'scoped-mcp-read', mcpHandoff: true } };
  let request: unknown = { protocol: launchProtocol, operation };
  if (operation !== 'status') {
    let input = ''; let size = 0;
    const timeout = setTimeout(() => { process.stderr.write('stdin 请求超时。\n'); process.exit(1); }, 10_000);
    try { for await (const chunk of process.stdin) { size += chunk.length; if (size > 64 * 1024) throw new Error('Request too large'); input += chunk.toString(); } }
    finally { clearTimeout(timeout); }
    request = JSON.parse(input);
  }
  const parsed = parseLaunchRequest(request);
  if (parsed.operation !== operation) throw new LaunchError('INVALID_COMMAND', '命令与请求操作不一致。');
  if (!['darwin', 'linux', 'win32'].includes(process.platform)) throw new LaunchError('UNSUPPORTED_PLATFORM', '不支持此平台。');
  const data = launchDataDirectory();
  const directory = controlDirectory(data);
  try { return await callControl(directory, parsed); }
  catch (error) {
    if (!['ENOENT', 'ECONNREFUSED'].includes(String((error as NodeJS.ErrnoException).code))) throw error;
    if (operation !== 'open-session') return { ok: true, data: { ready: false } };
  }
  const environment = { ...process.env }; delete environment.ELECTRON_RUN_AS_NODE;
  const executable = packaged ? process.execPath : join(root, 'node_modules/electron/dist', process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : process.platform === 'win32' ? 'electron.exe' : 'electron');
  const child = spawn(executable, [...(packaged ? [] : [root]), '--background'], { detached: true, stdio: ['ignore', 'ignore', process.env.DREAMEDGE_LAUNCH_DIAGNOSTICS === '1' ? 'pipe' : 'ignore'], env: environment, windowsHide: true });
  child.stderr?.on('data', bytes => process.stderr.write(bytes));
  let failed = false; child.on('error', () => { failed = true; }); child.unref();
  for (let attempt = 0; attempt < 100 && !failed; attempt++) {
    await delay(300);
    try { return await callControl(directory, parsed); }
    catch (error) { if (!['ENOENT', 'ECONNREFUSED'].includes(String((error as NodeJS.ErrnoException).code))) throw error; }
  }
  throw new LaunchError('START_TIMEOUT', '后台未就绪。请检查模型配置，或退出仍在运行的旧版 AI 应用后重试。');
}
void main().then(result => {
  process.stdout.write(JSON.stringify(result) + '\n');
  if (result && typeof result === 'object' && 'ok' in result && result.ok === false) process.exitCode = 1;
}, error => {
  process.stdout.write(JSON.stringify({ ok: false, error: { code: error instanceof LaunchError ? error.code : 'CLI_FAILED',
    message: error instanceof LaunchError ? error.message : '启动接口执行失败，请检查请求与本地配置。' } }) + '\n'); process.exitCode = 1;
});
