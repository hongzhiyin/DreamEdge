import { mkdir, writeFile, access, cp } from 'node:fs/promises';
import { resolve, basename } from 'node:path';

export async function createApp(directory, options) {
  if (!directory || !options.name || !options.id || !options.runtime || !options.sdk || !options.cli) {
    throw new Error('用法：dreamedge create <目录> --name <名称> --id <反向域名标识> --runtime <tgz> --sdk <tgz> --cli <tgz>');
  }
  const root = resolve(directory);
  try { await access(root); throw new Error('目标目录已存在，请使用新目录。'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  for (const path of [options.runtime, options.sdk, options.cli]) await access(resolve(path));
  if (!/^[a-zA-Z][a-zA-Z0-9]*(\.[a-zA-Z0-9-]+){2,}$/.test(options.id)) throw new Error('应用标识格式无效。');
  const id = options.id.split('.').at(-1).toLowerCase();
  if (id === 'shell' || !/^[a-z][a-z0-9-]{0,79}$/.test(id)) throw new Error('应用标识最后一段需以字母开头，并避开保留名称 shell。');
  await mkdir(resolve(root, 'ui'), { recursive: true });
  await mkdir(resolve(root, 'vendor'), { recursive: true });
  for (const path of [options.runtime, options.sdk, options.cli]) await cp(resolve(path), resolve(root, 'vendor', basename(path)));
  const manifest = { id, appId: options.id, name: options.name, description: '独立的 DreamEdge 应用',
    version: '0.1.0', entry: 'index.html', renderer: 'ui', capabilities: ['storage'] };
  const pkg = { name: id, version: '0.1.0', private: true, main: 'dist/main.cjs',
    scripts: { build: 'dreamedge build', start: 'npm run build && electron .', package: 'dreamedge package' },
    dependencies: { '@dreamedge/desktop': `file:vendor/${basename(options.runtime)}`, '@dreamedge/sdk': `file:vendor/${basename(options.sdk)}` },
    devDependencies: { '@dreamedge/cli': `file:vendor/${basename(options.cli)}`, electron: '44.5.1', 'electron-builder': '26.15.3' } };
  await writeFile(resolve(root, 'package.json'), JSON.stringify(pkg, null, 2));
  await writeFile(resolve(root, 'app.config.json'), JSON.stringify(manifest, null, 2));
  await writeFile(resolve(root, '.gitignore'), 'node_modules/\ndist/\nrelease/\n*.sqlite*\n');
  await writeFile(resolve(root, 'ui/index.html'), '<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><div id="root"></div><script type="module" src="./main.ts"></script></html>');
  await writeFile(resolve(root, 'ui/main.ts'), "document.getElementById('root')!.textContent = 'HelloWorld';\n");
  console.log(`Created ${options.name} at ${root}. Install dependencies and run npm start.`);
}
