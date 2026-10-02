import { build } from 'vite';
import { resolve } from 'node:path';
import { readFile, writeFile, mkdir, cp } from 'node:fs/promises';
import { build as bundle } from 'esbuild';

const manifest = JSON.parse(await readFile('app.config.json', 'utf8'));
const toolOnly = process.argv.includes('--tool');
if (toolOnly && process.argv.at(-1) !== manifest.id) throw new Error('未知业务项目。');
const targets = [
  [manifest.renderer, `dist/tools/${manifest.id}`],
];
for (const [root, output] of targets) {
  await build({
    configFile: false, root: resolve(root), base: './',
    build: { outDir: resolve(output), emptyOutDir: true },
  });
}
if (!toolOnly) {
  await mkdir('dist/desktop/desktop', { recursive: true });
  await bundle({ entryPoints: ['desktop/main.ts'], bundle: true, platform: 'node', format: 'cjs',
    target: 'node22', external: ['electron'], outfile: 'dist/desktop/desktop/main.js' });
  await cp('packages/desktop/dist/preload.cjs', 'dist/desktop/desktop/preload.cjs');
  await cp('packages/desktop/dist/shell', 'dist/shell', { recursive: true });
  await writeFile('dist/app.json', JSON.stringify(manifest, null, 2));
}
