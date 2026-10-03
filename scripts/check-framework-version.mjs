import { readFile } from 'node:fs/promises';
import { valid } from 'semver';

const read = async path => JSON.parse(await readFile(path, 'utf8'));
const { version } = await read('package.json');
if (!/^\d+\.\d+\.\d+$/.test(version) || valid(version) !== version) throw new Error('框架版本必须是数字形式，例如 0.1.2。');
for (const path of ['app.config.json', 'packages/desktop/package.json', 'packages/sdk/package.json', 'packages/cli/package.json']) {
  const metadata = await read(path);
  if (metadata.version !== version) throw new Error(`${path} 的版本必须与框架 ${version} 一致。`);
  if (metadata.peerDependencies?.['@dreamedge/desktop'] && metadata.peerDependencies['@dreamedge/desktop'] !== version) {
    throw new Error('CLI 必须固定到同版本 DreamEdge 桌面框架。');
  }
}
const lock = await read('package-lock.json');
if (lock.version !== version || lock.packages?.[''].version !== version) throw new Error('依赖锁中的框架版本需要同步更新。');
console.log(`Framework version verified: ${version}`);
