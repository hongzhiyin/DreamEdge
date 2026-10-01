import { build } from 'vite';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';

const manifest = JSON.parse(await readFile('tools/reading-log/manifest.json', 'utf8'));
const toolOnly = process.argv.includes('--tool');
if (toolOnly && process.argv.at(-1) !== manifest.id) throw new Error('未知工具，请指定 reading-log。');
const targets = [
  ...(!toolOnly ? [['shell', 'dist/shell']] : []),
  [`tools/${manifest.id}`, `dist/tools/${manifest.id}`],
];
for (const [root, output] of targets) {
  await build({
    configFile: false, root: resolve(root), base: './',
    build: { outDir: resolve(output), emptyOutDir: true },
  });
}
