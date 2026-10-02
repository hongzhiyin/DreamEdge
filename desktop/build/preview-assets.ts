import { extname, join } from 'node:path';
import type { CandidateBuild, WorkspaceProject } from '../../shared/contracts';
import { hash, readText, relativeParts } from '../workspace/paths';
import { buildRoot, previewUrl } from './store';

const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8' };
export async function servePreview(project: WorkspaceProject, record: CandidateBuild, rawUrl: string): Promise<Response> {
  try {
    const url = new URL(rawUrl);
    if (record.status !== 'succeeded' || url.origin !== new URL(previewUrl(record.id)).origin
        || url.protocol !== 'dreamedge-preview:' || url.hostname !== new URL(previewUrl(record.id)).hostname
        || url.search || url.username || url.password || url.port) throw new Error('Invalid preview URL');
    const path = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname).slice(1);
    relativeParts(path);
    if (!Object.hasOwn(record.outputHashes, path) || !mime[extname(path)]) throw new Error('Unknown artifact');
    const content = await readText(join(buildRoot(project, record.id), 'output'), path);
    if (hash(content) !== record.outputHashes[path]) throw new Error('Artifact changed');
    return new Response(content, { headers: {
      'Content-Type': mime[extname(path)], 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    } });
  } catch { return new Response('候选预览资源无法加载。', { status: 404 }); }
}
