import { build as bundle } from 'esbuild';
import { build } from 'vite';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

await mkdir('packages/desktop/dist', { recursive: true });
for (const [source, name] of [['runtime', 'runtime'], ['project', 'project'], ['preload', 'preload'], ['build/worker', 'build-worker']]) {
  await bundle({ entryPoints: [`desktop/${source}.ts`], bundle: true, platform: 'node', format: 'cjs',
    target: 'node22', external: ['electron', 'esbuild'], outfile: `packages/desktop/dist/${name}.cjs` });
}
await build({ configFile: false, root: resolve('shell'), base: './',
  build: { outDir: resolve('packages/desktop/dist/shell'), emptyOutDir: true } });
