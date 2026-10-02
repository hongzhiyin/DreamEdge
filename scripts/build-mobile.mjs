import { build } from 'vite';
import { resolve } from 'node:path';

await build({
  configFile: false, root: resolve('mobile'), base: './',
  build: { outDir: resolve('dist/mobile'), emptyOutDir: true, target: 'safari15' },
});
