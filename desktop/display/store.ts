import { rm, readdir } from 'node:fs/promises';
import { join, extname } from 'node:path';
import type { WorkspaceProject } from '../../shared/contracts';
import { identifier } from '../development/sessions';
import { directory, ensureDirectory, hash, readText, relativeParts, writeText } from '../workspace/paths';
import { equalHashes, validHashes } from '../workspace/source-tree';
import type { BuildOutput } from '../build/types';
import { publishOutput } from '../build/output';

export interface DisplayRecord {
  schemaVersion: 1; id: string; projectId: string; definitionHash: string;
  sourceHashes: Record<string, string>; outputHashes: Record<string, string>;
}
const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8' };
export const DISPLAY_PREFIX = '__dreamedge_project';
export function displayEntry(record: DisplayRecord): string { return `${DISPLAY_PREFIX}/${record.id}/index.html`; }
export class DisplayStore {
  root(project: WorkspaceProject): Promise<string> { return ensureDirectory(project.buildDirectory, '.saved-view'); }
  async cached(project: WorkspaceProject, definitionHash: string, sourceHashes: Record<string, string>): Promise<DisplayRecord | null> {
    try {
      const record = JSON.parse(await readText(await this.root(project), 'record.json')) as DisplayRecord;
      identifier(record.id);
      if (record.schemaVersion !== 1 || record.projectId !== project.definition.id || record.definitionHash !== definitionHash
        || !validHashes(record.sourceHashes) || !validHashes(record.outputHashes) || !Object.hasOwn(record.outputHashes, 'index.html')
        || !equalHashes(record.sourceHashes, sourceHashes)) return null;
      const root = join(await this.root(project), record.id, 'output');
      for (const [path, expected] of Object.entries(record.outputHashes)) if (hash(await readText(root, path)) !== expected) return null;
      return record;
    } catch { return null; }
  }
  async publish(project: WorkspaceProject, id: string, definitionHash: string, sourceHashes: Record<string, string>, output: BuildOutput): Promise<DisplayRecord> {
    const root = await this.root(project); const target = await ensureDirectory(root, identifier(id));
    return { schemaVersion: 1, id, projectId: project.definition.id, definitionHash, sourceHashes,
      outputHashes: await publishOutput(target, output) };
  }
  async activate(project: WorkspaceProject, record: DisplayRecord): Promise<void> {
    const root = await this.root(project); await writeText(root, 'record.json', JSON.stringify(record));
    for (const name of await readdir(root)) if (name !== record.id && /^[0-9a-f-]{36}$/.test(name)) {
      await directory(join(root, name)); await rm(join(root, name), { recursive: true, force: true });
    }
  }
  async serve(project: WorkspaceProject, record: DisplayRecord, rawUrl: string): Promise<Response> {
    try {
      const url = new URL(rawUrl);
      if (record.projectId !== project.definition.id || url.hostname !== `p${project.definition.id.replaceAll('-', '')}` || url.protocol !== 'dreamedge:' || url.search || url.hash || url.username || url.password || url.port) throw new Error();
      const prefix = `/${DISPLAY_PREFIX}/${record.id}/`; if (!url.pathname.startsWith(prefix)) throw new Error();
      const path = decodeURIComponent(url.pathname.slice(prefix.length)); relativeParts(path);
      if (!Object.hasOwn(record.outputHashes, path) || !mime[extname(path)]) throw new Error();
      const content = await readText(join(await this.root(project), record.id, 'output'), path);
      if (hash(content) !== record.outputHashes[path]) throw new Error();
      return new Response(content, { headers: { 'Content-Type': mime[extname(path)], 'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors dreamedge://shell" } });
    } catch { return new Response('工程显示资源无法加载。', { status: 404 }); }
  }
}
