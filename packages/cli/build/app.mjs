import { readFile, writeFile, mkdir, rm, cp } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve, relative } from 'node:path';
import { build } from 'vite';

export async function buildApp(root = process.cwd()) {
  const require = createRequire(resolve(root, 'package.json'));
  const { validateManifest, servicePath } = require('@dreamedge/desktop/manifest');
  const manifest = validateManifest(JSON.parse(await readFile(resolve(root, 'app.config.json'), 'utf8')));
  const runtime = dirname(require.resolve('@dreamedge/desktop'));
  const output = resolve(root, 'dist');
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  await build({ configFile: false, root: resolve(root, manifest.renderer), base: './',
    build: { outDir: resolve(output, 'tools', manifest.id), emptyOutDir: true } });
  await cp(resolve(runtime, 'shell'), resolve(output, 'shell'), { recursive: true });
  for (const service of Object.values(manifest.services ?? {})) {
    const source = servicePath(root, service.entry);
    const target = resolve(output, 'services', relative(root, source));
    await mkdir(dirname(target), { recursive: true });
    await cp(dirname(source), dirname(target), { recursive: true });
    service.entry = relative(root, target).replaceAll('\\', '/');
  }
  await writeFile(resolve(output, 'app.json'), JSON.stringify(manifest, null, 2));
  await writeFile(resolve(output, 'main.cjs'), "require('@dreamedge/desktop').startApp();\n");
  const config = {
    appId: manifest.appId, productName: manifest.name,
    directories: { output: 'release' }, files: ['dist/**/*', 'package.json'],
    asar: true, asarUnpack: ['node_modules/esbuild/**', 'node_modules/@esbuild/**'],
    npmRebuild: false, artifactName: '${productName}-${version}-${os}-${arch}.${ext}',
    mac: { identity: '-', category: 'public.app-category.utilities', target: ['dmg', 'zip'] },
    win: { target: ['nsis'] }, nsis: { oneClick: false, allowToChangeInstallationDirectory: true },
  };
  await writeFile(resolve(output, 'builder.json'), JSON.stringify(config, null, 2));
  console.log(`Built ${manifest.name} (${manifest.appId}) with DreamEdge.`);
}
