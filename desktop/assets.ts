import { readFile } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve } from 'node:path';
import type { ToolManifest } from '../shared/contracts';

const types: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json',
};

export function assetPath(dist: string, rawUrl: string, catalog: ToolManifest[], resources?: ReadonlyMap<string, string>): string {
  const url = new URL(rawUrl);
  const tool = catalog.find(item => item.id === url.hostname);
  if (url.protocol !== 'dreamedge:' || (url.hostname !== 'shell' && !tool)) {
    throw new Error('未知工具地址。');
  }
  const root = resolve(dist, url.hostname === 'shell' ? 'shell' : `tools/${resources?.get(tool!.id) ?? tool!.id}`);
  const pathname = decodeURIComponent(url.pathname);
  const filename = resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
  const within = relative(root, filename);
  if (within.startsWith('..') || isAbsolute(within)) throw new Error('禁止越界读取。');
  return filename;
}

export async function serveAsset(dist: string, rawUrl: string, catalog: ToolManifest[], resources?: ReadonlyMap<string, string>, frameSources?: string): Promise<Response> {
  try {
    const filename = assetPath(dist, rawUrl, catalog, resources);
    const body = await readFile(filename);
    const csp = [
      "default-src 'none'", "script-src 'self'", "style-src 'self'",
      "img-src 'self' data:", "font-src 'self'", "connect-src 'none'",
      `frame-src ${frameSources ?? catalog.map(tool => `dreamedge://${tool.id}`).join(' ')}`, "object-src 'none'", "base-uri 'none'",
      "form-action 'none'", 'frame-ancestors dreamedge://shell',
    ].join('; ');
    return new Response(body, { headers: {
      'Content-Type': types[extname(filename)] ?? 'application/octet-stream',
      'Content-Security-Policy': csp,
      'X-Content-Type-Options': 'nosniff',
    } });
  } catch {
    return new Response('本地工具资源无法加载。', { status: 404 });
  }
}
