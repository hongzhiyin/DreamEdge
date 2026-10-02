import { createHash } from 'node:crypto';
import { maxSatisfying, valid } from 'semver';
import type { LockedPackage } from '../../shared/contracts';
import { REGISTRY, dependencies, packageName, registryUrl, validatePackage } from './policy';

export interface PackageRegistry {
  resolve(name: string, range: string, signal: AbortSignal): Promise<LockedPackage>;
  download(item: LockedPackage, signal: AbortSignal): Promise<Buffer>;
}
async function fetchBytes(url: string, signal: AbortSignal, limit: number, accept: string): Promise<Buffer> {
  const response = await fetch(url, { signal, redirect: 'error', headers: { accept } });
  if (!response.ok || !response.body) throw new Error(`npm 请求失败（${response.status}），请检查包名、版本和网络后重试。`);
  const chunks: Uint8Array[] = []; let bytes = 0;
  for await (const chunk of response.body) {
    signal.throwIfAborted(); bytes += chunk.length;
    if (bytes > limit) throw new Error('依赖下载超过框架大小限制。');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
export function verifyArchive(bytes: Buffer, integrity: string): void {
  if (`sha512-${createHash('sha512').update(bytes).digest('base64')}` !== integrity) throw new Error('依赖归档完整性校验失败。');
}
export class NpmRegistry implements PackageRegistry {
  async resolve(name: string, range: string, signal: AbortSignal): Promise<LockedPackage> {
    packageName(name); dependencies({ [name]: range }, false);
    const url = `${REGISTRY}/${encodeURIComponent(name)}${valid(range) === range ? '/' + range : ''}`;
    const document = JSON.parse((await fetchBytes(url, signal, 16 * 1024 * 1024, valid(range) === range ? 'application/json' : 'application/vnd.npm.install-v1+json')).toString('utf8'));
    const version = valid(range) === range ? range : maxSatisfying(Object.keys(document.versions ?? {}), range);
    const item = valid(range) === range ? document : document.versions?.[version!];
    if (!item || item.name !== name || item.version !== version) throw new Error(`没有匹配的依赖版本：${name} ${range}`);
    if (Object.keys(item.optionalDependencies ?? {}).length || item.os || item.cpu || item.libc) throw new Error(`${name} 包含可选或平台依赖，当前仅支持通用浏览器包。`);
    const peers = Object.fromEntries(Object.entries(item.peerDependencies ?? {}).filter(([key]) => !item.peerDependenciesMeta?.[key]?.optional));
    return validatePackage({ name, version, tarball: item.dist?.tarball, integrity: item.dist?.integrity,
      dependencies: dependencies(item.dependencies ?? {}, false), peers: dependencies(peers, false) });
  }
  async download(item: LockedPackage, signal: AbortSignal): Promise<Buffer> {
    const bytes = await fetchBytes(registryUrl(item.tarball), signal, 16 * 1024 * 1024, 'application/octet-stream');
    verifyArchive(bytes, item.integrity); return bytes;
  }
}
