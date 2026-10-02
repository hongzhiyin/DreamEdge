import { parse, serialize, type DefaultTreeAdapterMap } from 'parse5';
import { posix } from 'node:path';
type Node = DefaultTreeAdapterMap['node'];
type Element = DefaultTreeAdapterMap['element'];
export const BUNDLE_DIRECTORY = '__dreamedge_bundle';
export function sourcePath(importer: string, value: string): string {
  if (!value || /[\\\x00:#?]/.test(value) || value.startsWith('/')) throw new Error('构建资源必须是工程内的相对路径。');
  const path = posix.normalize(posix.join(posix.dirname(importer), value));
  if (path === '..' || path.startsWith('../')) throw new Error('构建资源路径越界。');
  return path;
}
export function htmlEntries(content: string) {
  const document = parse(content);
  const entries: { name: string; path: string; kind: 'script' | 'style'; node: Element }[] = [];
  const get = (node: Element, name: string) => node.attrs.find(attribute => attribute.name === name);
  function walk(node: Node, depth = 0) {
    if (depth > 100) throw new Error('HTML 层级过深。');
    if ('tagName' in node) {
      if (node.tagName === 'base' || node.tagName === 'iframe' || node.tagName === 'object' || node.tagName === 'embed') throw new Error('候选预览不支持 base、嵌入页面或插件。');
      if (node.tagName === 'script') {
        const src = get(node, 'src');
        if (!src || get(node, 'type')?.value.toLowerCase() !== 'module') throw new Error('当前仅支持带 src 的 module 脚本。');
        if (!/\.(ts|tsx|js|jsx)$/.test(src.value)) throw new Error('module 脚本必须使用 JS 或 TS 文件。');
        entries.push({ name: `module${entries.length}`, path: sourcePath('index.html', src.value), kind: 'script', node });
      }
      if (node.tagName === 'link' && get(node, 'rel')?.value.toLowerCase() === 'stylesheet') {
        const href = get(node, 'href');
        if (!href) throw new Error('样式表缺少相对路径。');
        if (!href.value.endsWith('.css')) throw new Error('样式入口必须使用 CSS 文件。');
        entries.push({ name: `style${entries.length}`, path: sourcePath('index.html', href.value), kind: 'style', node });
      }
      if ('content' in node) walk(node.content, depth + 1);
    }
    if ('childNodes' in node) for (const child of node.childNodes) walk(child, depth + 1);
  }
  walk(document);
  if (entries.length > 20) throw new Error('当前最多支持 20 个 HTML 构建入口。');
  return { entries, render(outputs: Set<string>) {
    for (const entry of entries) {
      const attribute = get(entry.node, entry.kind === 'script' ? 'src' : 'href')!;
      attribute.value = `./${BUNDLE_DIRECTORY}/${entry.name}.${entry.kind === 'script' ? 'js' : 'css'}`;
      entry.node.attrs = entry.node.attrs.filter(attribute => attribute.name !== 'integrity');
      if (entry.kind === 'script' && outputs.has(`${BUNDLE_DIRECTORY}/${entry.name}.css`)) {
        const link = parse(`<link rel="stylesheet" href="./${BUNDLE_DIRECTORY}/${entry.name}.css">`).childNodes
          .find(node => 'tagName' in node && node.tagName === 'html') as Element;
        const head = link.childNodes.find(node => 'tagName' in node && node.tagName === 'head') as Element;
        const style = head.childNodes[0];
        const parent = entry.node.parentNode!; parent.childNodes.push(style); style.parentNode = parent;
      }
    }
    return serialize(document);
  } };
}
