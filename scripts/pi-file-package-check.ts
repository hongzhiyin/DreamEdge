import { _electron as electron } from 'playwright';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { PiFileToolHost } from '../src/index.js';

async function main() {
  const { values } = parseArgs({ options: { root: { type: 'string', default: 'release/pi-file-adapter-validation' } } });
  const directory = await mkdtemp(join(tmpdir(), 'dreamedge-pi-package-'));
  const configPath = join(directory, 'connection.json'); const credentialsPath = join(directory, 'credentials.json');
  await writeFile(configPath, JSON.stringify({ id: 'fixture', protocol: 'openai-completions', baseUrl: 'http://127.0.0.1:1',
    model: 'fixture', contextWindow: 100000, maxOutputTokens: 8192, credentialRef: 'file:fixture' }));
  await writeFile(credentialsPath, '{}'); await writeFile(join(directory, 'input.txt'), 'packaged Pi file fixture\n');
  const env = Object.fromEntries(Object.entries(process.env).filter((item): item is [string, string] => typeof item[1] === 'string'));
  Object.assign(env, { DREAMEDGE_DATA_DIR: join(directory, 'profile'), DREAMEDGE_CONFIG_FILE: configPath,
    DREAMEDGE_CREDENTIALS_FILE: credentialsPath, DREAMEDGE_NO_DIALOGS: '1' }); delete env.ELECTRON_RUN_AS_NODE;
  const executablePath = resolve(values.root, `DreamEdge-${process.platform}-${process.arch}/DreamEdge.app/Contents/MacOS/DreamEdge`);
  const app = await electron.launch({ executablePath, args: [], env });
  try {
    await (await app.firstWindow()).getByLabel('消息', { exact: true }).waitFor();
    const checks = await app.evaluate(async ({ app }, directory) => {
      const { join } = process.getBuiltinModule('node:path');
      const require = process.getBuiltinModule('node:module').createRequire(join(app.getAppPath(), 'package.json'));
      const adapterPath = require.resolve('./dist/src/files/pi-file-tools.js');
      const { loadPiFileTools } = require(adapterPath) as typeof import('../src/files/pi-file-tools.js');
      // The inspector is CJS, while Pi publishes an import-only public entry.
      const sdkRoot = join(app.getAppPath(), 'node_modules/@earendil-works/pi-coding-agent');
      const manifest = require(join(sdkRoot, 'package.json')) as { exports: { '.': { import: string } } };
      const pi = require(join(sdkRoot, manifest.exports['.'].import)) as typeof import('@earendil-works/pi-coding-agent');
      const sdkRequire = process.getBuiltinModule('node:module').createRequire(join(sdkRoot, 'dist/index.js'));
      const versions = Object.fromEntries(['pi-ai', 'pi-agent-core', 'pi-coding-agent', 'pi-codemode', 'pi-mcp', 'pi-tui', 'chord']
        .map(name => {
          const locations = sdkRequire.resolve.paths(`@earendil-works/${name}`) ?? [];
          const metadata = locations.map(path => join(path, `@earendil-works/${name}/package.json`))
            .find(path => process.getBuiltinModule('node:fs').existsSync(path));
          if (!metadata?.startsWith(`${app.getAppPath()}/`)) throw new Error('Pi dependency resolved outside application archive');
          return [name, (require(metadata) as { version: string }).version];
        }));
      const read = pi.createReadTool(directory);
      let disposed = false;
      const host: PiFileToolHost = { async authorize(name, args) {
        if (name !== 'read' || args.path !== 'input.txt') throw new Error('fixture denied');
      }, async prepare() { return { tool: read, async dispose() { disposed = true; } }; } };
      const tools = await loadPiFileTools(host);
      const result = await tools[0]!.execute({ path: 'input.txt' }, { sessionId: 'fixture', runId: 'run', turnId: 'turn',
        toolCallId: 'read', signal: new AbortController().signal });
      return { packaged: app.isPackaged, sdkImportedFromArchive: adapterPath.includes('/app.asar/'),
        fixedVersions: Object.values(versions).every(version => version === '1.1.0'), versions,
        sixFactories: tools.length === 6, actualPiRead: result.content.some(block => block.type === 'text'
          && block.text.includes('packaged Pi file fixture')), disposed,
        electron: process.versions.electron, node: process.versions.node };
    }, directory);
    const passed = checks.packaged && checks.sdkImportedFromArchive && checks.fixedVersions && checks.sixFactories && checks.actualPiRead && checks.disposed;
    const report = { date: '2026-10-15', passed, checks, scope: 'Production validation .app, real Pi SDK from asar, isolated fixture; no model requests.' };
    await mkdir('docs/validation', { recursive: true });
    await writeFile('docs/validation/pi-file-package-2026-10-15.json', `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(report)}\n`); if (!passed) process.exitCode = 1;
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
}
void main().catch(error => {
  process.stderr.write(`Pi 文件工具应用包验证失败：${error instanceof Error ? error.message : 'unknown'}\n`);
  process.exitCode = 1;
});
