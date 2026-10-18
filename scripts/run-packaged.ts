import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { access } from 'node:fs/promises';
import { parseArgs } from 'node:util';

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { 'app-root': { type: 'string', default: 'release' } } });
  const root = resolve(values['app-root'], `DreamEdge-${process.platform}-${process.arch}`);
  const executable = process.platform === 'darwin' ? resolve(root, 'DreamEdge.app/Contents/MacOS/DreamEdge')
    : resolve(root, process.platform === 'win32' ? 'DreamEdge.exe' : 'DreamEdge');
  await access(executable);
  const environment: NodeJS.ProcessEnv = { ...process.env,
    DREAMEDGE_CONFIG_FILE: process.env.DREAMEDGE_CONFIG_FILE ?? resolve('config/deepseek.example.json'),
    DREAMEDGE_CREDENTIALS_FILE: process.env.DREAMEDGE_CREDENTIALS_FILE ?? resolve('config/credentials.local.json') };
  delete environment.ELECTRON_RUN_AS_NODE;
  const child = spawn(executable, [], { env: environment, stdio: 'inherit' });
  child.on('error', () => { process.stderr.write('无法打开已打包应用。\n'); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
}
void main().catch(() => { process.stderr.write('未找到应用包，请先运行 npm run package:app。\n'); process.exitCode = 1; });
