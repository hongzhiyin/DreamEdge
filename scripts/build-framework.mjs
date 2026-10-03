import { build as bundle } from 'esbuild';
import { build } from 'vite';
import { mkdir, cp } from 'node:fs/promises';
import { resolve } from 'node:path';

await mkdir('packages/desktop/dist', { recursive: true });
for (const [source, name] of [['runtime', 'runtime'], ['project', 'project'], ['preload', 'preload'], ['build/worker', 'build-worker'], ['export/worker', 'export-worker']]) {
  await bundle({ entryPoints: [`desktop/${source}.ts`], bundle: true, platform: 'node', format: 'cjs',
    target: 'node22', external: ['electron', 'esbuild', 'app-builder-lib'], outfile: `packages/desktop/dist/${name}.cjs` });
}
await build({ configFile: false, root: resolve('shell'), base: './',
  build: { outDir: resolve('packages/desktop/dist/shell'), emptyOutDir: true } });

await cp('THIRD_PARTY_NOTICES.txt', 'packages/desktop/dist/THIRD_PARTY_NOTICES.txt');
