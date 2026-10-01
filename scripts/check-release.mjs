import { readFile } from 'node:fs/promises';

const { version } = JSON.parse(await readFile('package.json', 'utf8'));
const tag = process.env.GITHUB_REF_NAME;
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version) || tag !== `v${version}`) {
  throw new Error(`版本标签 ${tag} 必须与 package.json 中的 v${version} 一致。`);
}
console.log(`Release version verified: ${tag}`);
