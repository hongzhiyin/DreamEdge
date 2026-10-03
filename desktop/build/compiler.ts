import { build, type Loader, type Message } from 'esbuild';
import { posix } from 'node:path';
import type { BuildLog } from '../../shared/contracts';
import { relativeParts } from '../workspace/paths';
import { BUNDLE_DIRECTORY, htmlEntries, sourcePath } from './html';
import { BuildFailure, type BuildInput, type BuildOutput } from './types';
import { sdkBrowserSource } from './sdk-browser';
import { DependencyModules } from './dependency-modules';

const loaders: Record<string, Loader> = { '.ts': 'ts', '.tsx': 'tsx', '.js': 'js', '.mjs': 'js', '.cjs': 'js', '.jsx': 'jsx', '.json': 'json', '.css': 'css', '.svg': 'dataurl', '.txt': 'text' };
function diagnostic(message: Message, level: 'error' | 'warning'): BuildLog {
  const location = message.location;
  return { level, message: message.text.slice(0, 2000), ...(location ? {
    path: location.file.replace(/^project:/, ''), line: location.line, column: location.column } : {}) };
}
export async function compile(input: BuildInput): Promise<BuildOutput> {
  try {
    const files = input.files;
    const modules = input.dependencyLock ? new DependencyModules(input.dependencyFiles ?? {}, input.dependencyLock) : null;
    for (const path of Object.keys(files)) {
      relativeParts(path);
      if (path === BUNDLE_DIRECTORY || path.startsWith(BUNDLE_DIRECTORY + '/')) throw new Error('源码不能使用框架保留的构建产物目录。');
    }
    if (typeof files['index.html'] !== 'string') throw new Error('工程缺少 index.html。');
    const html = htmlEntries(files['index.html']);
    const outputs: Record<string, string> = Object.create(null);
    const logs: BuildLog[] = [];
    if (html.entries.length) {
      const result = await build({ entryPoints: html.entries.map(entry => ({ in: entry.path, out: entry.name })),
        outdir: '/output', write: false, bundle: true, platform: 'browser', format: 'esm', target: 'es2022',
        logLevel: 'silent', sourcemap: false, metafile: false, tsconfigRaw: {}, jsx: 'automatic',
        define: { 'process.env.NODE_ENV': '"production"' },
        plugins: [{ name: 'dreamedge-source', setup(engine) {
          engine.onResolve({ filter: /.*/ }, args => {
            if (args.path === '@dreamedge/sdk' && args.namespace !== 'dependency') return { path: '@dreamedge/sdk', namespace: 'framework-sdk' };
            if (args.namespace === 'dependency' || args.kind !== 'entry-point' && !args.path.startsWith('./') && !args.path.startsWith('../')) {
              try {
                if (!modules) throw new Error('工程未声明外部依赖；禁止远程或 Node.js 模块。');
                return { path: modules.resolve(args.path, args.namespace === 'dependency' ? args.importer : '', args.kind), namespace: 'dependency' };
              } catch (error) { return { errors: [{ text: error instanceof Error ? error.message : '依赖解析失败。' }] }; }
            }
            try {
              const path = args.kind === 'entry-point' ? args.path : sourcePath(args.importer, args.path);
              relativeParts(path);
              const resolved = [path, ...['.ts', '.tsx', '.js', '.jsx', '.json', '/index.ts', '/index.js'].map(suffix => path + suffix)]
                .find(name => Object.hasOwn(files, name));
              if (!resolved) return { errors: [{ text: `源码文件不存在：${path}` }] };
              return { path: resolved, namespace: 'project' };
            } catch { return { errors: [{ text: '禁止导入工程源码范围之外的资源。' }] }; }
          });
          engine.onLoad({ filter: /.*/, namespace: 'framework-sdk' }, () => ({ contents: sdkBrowserSource, loader: 'js' }));
          engine.onLoad({ filter: /.*/, namespace: 'dependency' }, args => {
            if (args.path === '__empty__') return { contents: '', loader: 'js' };
            const loader = loaders[posix.extname(args.path)];
            return loader ? { contents: modules!.files[args.path], loader } : { errors: [{ text: '不支持的依赖文件类型。' }] };
          });
          engine.onLoad({ filter: /.*/, namespace: 'project' }, args => {
            const loader = loaders[posix.extname(args.path)];
            return loader ? { contents: files[args.path], loader } : { errors: [{ text: '不支持的源码文件类型。' }] };
          });
        } }],
      });
      for (const file of result.outputFiles) outputs[`${BUNDLE_DIRECTORY}/${posix.basename(file.path)}`] = file.text;
      logs.push(...result.warnings.slice(0, 30).map(message => diagnostic(message, 'warning')));
    }
    for (const [path, content] of Object.entries(files)) if (/\.(svg|json|txt)$/.test(path)) outputs[path] = content;
    outputs['index.html'] = html.render(new Set(Object.keys(outputs)));
    logs.push({ level: 'info', message: `构建完成，共 ${Object.keys(outputs).length} 个产物文件。` });
    return { files: outputs, logs };
  } catch (error) {
    if (error && typeof error === 'object' && 'errors' in error && Array.isArray(error.errors)) {
      throw new BuildFailure(error.errors.slice(0, 30).map(message => diagnostic(message, 'error')));
    }
    throw new BuildFailure([{ level: 'error', message: error instanceof Error ? error.message.slice(0, 2000) : '构建失败。' }]);
  }
}
