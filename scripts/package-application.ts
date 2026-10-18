import { packager } from '@electron/packager';
import { listPackage, extractFile } from '@electron/asar';
import { readFile, access, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { execFileSync } from 'node:child_process';

function excluded(path: string): boolean {
  if (path === '') return false;
  if (/\.local\.json$|\/\.env(?:\.|$)|\/node_modules\/\.(?:bin|cache)(?:\/|$)/.test(path)) return true;
  if (path.startsWith('/node_modules/') || path === '/node_modules') return false;
  if (['/dist', '/config', '/package.json', '/licenses'].includes(path) || path.startsWith('/licenses/')) return false;
  if (/^\/dist\/(?:src|desktop|renderer|web|cli)(?:\/|$)/.test(path)) return false;
  return !['/config/deepseek.example.json', '/config/credentials.example.json'].includes(path);
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { out: { type: 'string', default: 'release' }, arch: { type: 'string' } } });
  const metadata = JSON.parse(await readFile('package.json', 'utf8')) as { devDependencies: { electron: string } };
  const platform = process.platform; const arch = values.arch ?? process.arch;
  if (platform !== 'darwin' && platform !== 'linux' && platform !== 'win32') throw new Error('Unsupported platform');
  if (arch !== 'arm64' && arch !== 'x64') throw new Error('Unsupported architecture');
  const paths = await packager({ dir: resolve('.'), name: 'DreamEdge', out: values.out,
    platform, arch, electronVersion: metadata.devDependencies.electron,
    appBundleId: 'app.dreamedge.desktop', asar: { unpack: '**/node_modules/@vscode/ripgrep-*/bin/**' }, prune: true, overwrite: true, ignore: excluded });
  for (const path of paths) {
    if (platform === 'darwin') {
      await writeFile(join(path, 'DreamEdge.app/Contents/MacOS/dreamedge-cli'),
        '#!/bin/sh\nset -eu\ncli_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"\nexport ELECTRON_RUN_AS_NODE=1\nexec "$cli_dir/DreamEdge" "$cli_dir/../Resources/app.asar/dist/cli/main.js" "$@"\n', { mode: 0o755 });
      await writeFile(join(path, 'ai-entry.json'), JSON.stringify({ protocol: 'ai-session-launch/v1', name: 'DreamEdge',
        transport: { type: 'stdio', command: resolve(path, 'DreamEdge.app/Contents/MacOS/dreamedge-cli'), args: [] },
        capabilities: { background: true, embeddedPage: true, resume: true, context: 'scoped-mcp-read', mcpHandoff: true } }, null, 2) + '\n');
    }
    if (platform === 'win32') {
      execFileSync('dotnet', ['publish', 'cli/windows/DreamEdge.Launcher.csproj', '-c', 'Release', '-r', `win-${arch}`,
        '--self-contained', 'true', '-p:DebugType=None', '-p:DebugSymbols=false', '-o', path], { stdio: 'inherit' });
      await writeFile(join(path, 'ai-entry.json'), JSON.stringify({ protocol: 'ai-session-launch/v1', name: 'DreamEdge',
        transport: { type: 'stdio', command: 'dreamedge-cli.exe', args: [] },
        capabilities: { background: true, embeddedPage: true, resume: true, context: 'scoped-mcp-read', mcpHandoff: true } }, null, 2) + '\n');
      await writeFile(join(path, 'export-ai-entry.cmd'), '@echo off\r\n"%~dp0dreamedge-cli.exe" describe > "%~dp0ai-entry.json"\r\n');
      await writeFile(join(path, 'Windows-README.txt'), 'DreamEdge Windows preview\r\n1. Extract the complete folder. Open DreamEdge.exe and configure your model.\r\n2. In RecollectionGarden choose Settings > Configure AI and import ai-entry.json from this folder.\r\n3. Connect from the currently open book. Confirm the application/MCP scope in DreamEdge.\r\nThe relative launcher name resolves beside ai-entry.json. After moving the folder, reimport it.\r\nData: %APPDATA%/DreamEdge. No API keys or personal data are included.\r\n');
    }
    const archive = process.platform === 'darwin'
      ? join(path, 'DreamEdge.app/Contents/Resources/app.asar') : join(path, 'resources/app.asar');
    const entries = listPackage(archive, { isPack: false });
    if (entries.some(entry => /\.local\.json$|^\/(?:test|src|docs|desktop|renderer|scripts|\.git)(?:\/|$)|\/dist\/test(?:\/|$)/.test(entry))) {
      throw new Error('Private or development files found in application archive');
    }
    if (!entries.includes('/dist/web/server.js')) throw new Error('Missing packaged web host');
    if (!entries.includes('/dist/cli/main.js')) throw new Error('Missing packaged launch CLI');
    if (!entries.includes('/node_modules/@earendil-works/pi-coding-agent/package.json')
      || !entries.includes('/dist/src/files/pi-read-worker.js')) throw new Error('Missing packaged Pi file runtime');
    if (!entries.includes('/dist/web/server.js') || !entries.includes('/dist/desktop/mcp.js') || !entries.includes('/dist/src/mcp/control.js')) throw new Error('Missing web/MCP runtime');
    for (const name of ['cordis', 'dsh-fs-local', 'dsh-fs', 'dsh-llm', 'dsh-timeout']) {
      if (!entries.includes(`/node_modules/@deepseek-ai/${name}/lib/index.js`)) throw new Error('Missing packaged DSH file runtime');
      if (!entries.includes(`/node_modules/@deepseek-ai/${name}/LICENSE`)) throw new Error('Missing packaged DSH license');
    }
    const piLicense = await readFile('licenses/Pi-1.1.0-LICENSE.txt');
    if (!entries.includes('/licenses/Pi-1.1.0-LICENSE.txt')
      || !extractFile(archive, 'licenses/Pi-1.1.0-LICENSE.txt').equals(piLicense)) throw new Error('Missing packaged Pi license');
    const executable = `node_modules/@vscode/ripgrep-${platform}-${arch}/bin/${platform === 'win32' ? 'rg.exe' : 'rg'}`;
    await access(join(`${archive}.unpacked`, executable));
    const bundled = await readFile(archive);
    let privateKeys: Record<string, unknown> = {};
    try { privateKeys = JSON.parse(await readFile('config/credentials.local.json', 'utf8')); } catch { /* Optional local credentials. */ }
    for (const value of Object.values(privateKeys)) {
      if (typeof value === 'string' && value && bundled.includes(Buffer.from(value))) {
        throw new Error('Local credential found in application archive');
      }
    }
    process.stdout.write(`应用包已创建并通过私有文件检查：${path}\n`);
  }
}
void main().catch(error => { process.stderr.write('应用打包或私有文件检查失败：' + String(error) + '\n'); process.exitCode = 1; });
