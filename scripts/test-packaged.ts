import { spawn } from 'node:child_process';
import { access, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { 'app-root': { type: 'string', default: 'release' } } });
  const root = resolve(values['app-root'], `DreamEdge-${process.platform}-${process.arch}`);
  const executable = process.platform === 'darwin' ? resolve(root, 'DreamEdge.app/Contents/MacOS/DreamEdge')
    : resolve(root, process.platform === 'win32' ? 'DreamEdge.exe' : 'DreamEdge');
  await access(executable);
  // These fixtures launch source hosts, so they are not evidence about the shipped app.
  const sourceHosts = new Set(['tools.test.js', 'web-browser.test.js', 'reading-browser.test.js']);
  const tests = (await readdir('dist/test/ui')).filter(path => path.endsWith('.test.js') && !sourceHosts.has(path))
    .map(path => resolve('dist/test/ui', path));
  const child = spawn(process.execPath, ['--test', '--test-concurrency=1', ...tests], {
    stdio: 'inherit', env: { ...process.env, DREAMEDGE_PACKAGE_EXECUTABLE: executable },
  });
  child.on('error', () => { process.stderr.write('无法运行应用包验证。\n'); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
}
void main().catch(() => { process.stderr.write('未找到应用包或测试入口，请先完成打包。\n'); process.exitCode = 1; });
