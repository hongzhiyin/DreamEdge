import { build as bundle } from 'esbuild';
import { build } from 'vite';
import { mkdir, cp, rename } from 'node:fs/promises';
import { resolve } from 'node:path';

await mkdir('packages/desktop/dist', { recursive: true });
for (const [source, name] of [['runtime', 'runtime'], ['business-runtime', 'business-runtime'], ['project', 'project'], ['preload', 'preload'], ['build/worker', 'build-worker'], ['export/worker', 'export-worker']]) {
  await bundle({ entryPoints: [`desktop/${source}.ts`], bundle: true, platform: 'node', format: 'cjs',
    target: 'node22', external: ['electron', 'esbuild', 'app-builder-lib'], outfile: `packages/desktop/dist/${name}.cjs` });
}
await build({ configFile: false, root: resolve('shell'), base: './',
  build: { outDir: resolve('packages/desktop/dist/shell'), emptyOutDir: true } });

await build({ configFile: false, root: resolve('shell'), base: './',
  build: { outDir: resolve('packages/desktop/dist/business-shell'), emptyOutDir: true, rollupOptions: { input: resolve('shell/business.html') } } });
await rename('packages/desktop/dist/business-shell/business.html', 'packages/desktop/dist/business-shell/index.html');

await cp('THIRD_PARTY_NOTICES.txt', 'packages/desktop/dist/THIRD_PARTY_NOTICES.txt');
