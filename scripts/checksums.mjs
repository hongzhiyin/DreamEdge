import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const directory = process.argv[2];
if (!directory) throw new Error('请指定安装包目录。');
const files = (await readdir(directory)).filter(name => /\.(dmg|zip|exe)$/.test(name)).sort();
if (files.length === 0) throw new Error('目录中没有安装包。');
const lines = [];
for (const name of files) {
  const digest = createHash('sha256').update(await readFile(join(directory, name))).digest('hex');
  lines.push(`${digest}  ${name}`);
}
await writeFile(join(directory, 'SHA256SUMS.txt'), `${lines.join('\n')}\n`);
console.log(`Checksums generated for ${files.length} packages.`);
