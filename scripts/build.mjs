import { build } from 'vite';
import { resolve } from 'node:path';
import { readFile, writeFile, mkdir, cp, rm } from 'node:fs/promises';
import { build as bundle } from 'esbuild';

const manifest = JSON.parse(await readFile('app.config.json', 'utf8'));
await rm('dist/tools', { recursive: true, force: true });
await build({
  configFile: false, root: resolve(manifest.renderer), base: './',
  build: { outDir: resolve(`dist/tools/${manifest.id}`), emptyOutDir: true },
});
await rm('dist/desktop', { recursive: true, force: true });
await rm('dist/shell', { recursive: true, force: true });
await mkdir('dist/desktop/desktop', { recursive: true });
await bundle({ entryPoints: ['desktop/main.ts'], bundle: true, platform: 'node', format: 'cjs',
    target: 'node22', external: ['electron'], outfile: 'dist/desktop/desktop/main.js' });
await cp('packages/desktop/dist/THIRD_PARTY_NOTICES.txt', 'dist/desktop/THIRD_PARTY_NOTICES.txt');
await cp('packages/desktop/dist/preload.cjs', 'dist/desktop/desktop/preload.cjs');
await cp('packages/desktop/dist/build-worker.cjs', 'dist/desktop/desktop/build-worker.cjs');
await cp('packages/desktop/dist/shell', 'dist/shell', { recursive: true });
await writeFile('dist/app.json', JSON.stringify(manifest, null, 2));
