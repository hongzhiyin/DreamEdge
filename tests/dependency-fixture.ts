import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { c } from 'tar';
import { maxSatisfying } from 'semver';
import type { LockedPackage } from '../shared/contracts';
import type { PackageRegistry } from '../desktop/dependencies/registry';

export async function archive(files: Record<string, string>): Promise<Buffer> {
  const root = await mkdtemp(join(tmpdir(), 'dreamedge-archive-'));
  try {
    await mkdir(join(root, 'package'));
    for (const [path, content] of Object.entries(files)) {
      const target = join(root, 'package', path);
      await mkdir(join(target, '..'), { recursive: true }); await writeFile(target, content);
    }
    const chunks: Buffer[] = [];
    for await (const chunk of c({ cwd: root, gzip: true, portable: true }, ['package'])) chunks.push(chunk);
    return Buffer.concat(chunks);
  } finally { await rm(root, { recursive: true, force: true }); }
}
export async function packageRegistry() {
  const records = new Map<string, LockedPackage>(); const archives = new Map<string, Buffer>();
  let resolves = 0; let downloads = 0; let offline = false;
  async function add(name: string, version: string, files: Record<string, string>, dependencies = {}, peers = {}) {
    const metadata = { name, version, main: 'index.js', dependencies, peerDependencies: peers,
      scripts: { install: 'node should-never-run.js' } };
    const bytes = await archive({ 'package.json': JSON.stringify(metadata), 'should-never-run.js': "throw new Error('INSTALL SCRIPT RAN');", ...files });
    const item: LockedPackage = { name, version, dependencies, peers, tarball: `https://registry.npmjs.org/${name}/-/${name.split('/').at(-1)}-${version}.tgz`,
      integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64') };
    records.set(`${name}@${version}`, item); archives.set(item.tarball, bytes); return item;
  }
  const registry: PackageRegistry = {
    resolve: async (name, range, signal) => {
      signal.throwIfAborted(); resolves++; if (offline) throw new Error('Offline registry should not be used');
      const version = maxSatisfying([...records.values()].filter(item => item.name === name).map(item => item.version), range);
      if (!version) throw new Error('Missing fixture package'); return structuredClone(records.get(`${name}@${version}`)!);
    },
    download: async (item, signal) => { signal.throwIfAborted(); downloads++; if (offline) throw new Error('Offline registry should not be used'); return archives.get(item.tarball)!; },
  };
  return { registry, add, offline: () => { offline = true; }, stats: () => ({ resolves, downloads }), records, archives };
}
