import { cp, mkdir, readdir, rename } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { PackagerOptions } from 'app-builder-lib';
import { createRequire } from 'node:module';
import type { ExportInput } from './types';

async function run(input: ExportInput & { template: string; electronVersion: string }) {
  process.noAsar = true;
  const require = createRequire(join(input.root, 'tooling/package.json'));
  const denyNetwork = () => { throw new Error('App 打包仅使用本地运行环境，禁止网络下载。'); };
  for (const protocol of ['node:http', 'node:https']) { const module = require(protocol); module.request = denyNetwork; module.get = denyNetwork; }
  globalThis.fetch = async () => denyNetwork();
  const { build, Packager, Platform, Arch } = require('app-builder-lib') as typeof import('app-builder-lib');
  const templateRoot = join(input.root, 'electron'); await mkdir(templateRoot);
  await cp(input.template, join(templateRoot, basename(input.template)), { recursive: true, verbatimSymlinks: true,
    filter: source => !['app.asar', 'app.asar.unpacked', 'default_app.asar', 'app', '_CodeSignature'].includes(basename(source)) });
  const productName = basename(input.template, '.app'); const output = join(input.root, 'packed');
  const options: PackagerOptions & { publish: 'never' } = { projectDir: join(input.root, 'application'), targets: Platform.MAC.createTarget(['dir', 'zip'], process.arch === 'arm64' ? Arch.arm64 : Arch.x64),
    publish: 'never' as const, config: { appId: input.manifest.appId, productName: input.manifest.name, electronVersion: input.electronVersion,
      electronDist: templateRoot, electronBranding: { projectName: 'electron', productName },
      directories: { output }, files: ['dist/**/*', 'node_modules/**/*', 'package.json'], beforeBuild: async () => false,
      asar: true, asarUnpack: ['node_modules/esbuild/**', 'node_modules/@esbuild/**'],
      mac: { identity: '-', notarize: false, target: ['dir', 'zip'], category: 'public.app-category.utilities' },
      artifactName: '${productName}-${version}-mac-${arch}.${ext}',
    } };
  class OfflinePackager extends Packager { async getWorkspaceRoot() { return this.projectDir; } }
  await build(options, new OfflinePackager(options));
  const deliverable = join(input.root, 'deliverable');
  const mac = join(output, process.arch === 'arm64' ? 'mac-arm64' : 'mac');
  for (const file of await readdir(mac)) if (file.endsWith('.app')) await rename(join(mac, file), join(deliverable, file));
  for (const file of await readdir(output)) if (file.endsWith('.zip')) await rename(join(output, file), join(deliverable, file));
}
let text = '';
process.stdin.setEncoding('utf8'); process.stdin.on('data', chunk => { text += chunk; if (text.length > 16384) process.exit(1); });
process.stdin.on('end', () => { void run(JSON.parse(text)).then(() => process.stdout.write('\nDREAMEDGE_EXPORT_OK\n')).catch(error => { console.error(String(error)); process.exitCode = 1; }); });
