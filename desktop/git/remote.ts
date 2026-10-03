import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { GitRemote } from '../../packages/sdk/src/git';
import { git } from './command';

const optional = (root: string, args: string[]) => git(root, args).then(text => text.trim()).catch(() => '');
export function displayRemoteUrl(value: string): string {
  try { const url = new URL(value); url.username = ''; url.password = ''; url.search = ''; url.hash = ''; return url.toString(); }
  catch { return value.replace(/^[^/@:]+@/, '').replace(/[\r\n]/g, ''); }
}
export async function remoteStatus(root: string, branch: string, head: string | null) {
  const names = (await git(root, ['remote'])).trim().split('\n').filter(Boolean);
  const remotes = await Promise.all(names.map(async name => ({ name, url: displayRemoteUrl(await optional(root, ['remote', 'get-url', name])) })));
  const configured = await optional(root, ['config', '--get', `branch.${branch}.remote`]);
  const name = configured ? names.includes(configured) ? configured : undefined : names.includes('origin') ? 'origin' : names.length === 1 ? names[0] : undefined;
  let remote: GitRemote | null = null;
  if (name && branch !== 'HEAD') {
    const merge = configured === name ? await optional(root, ['config', '--get', `branch.${branch}.merge`]) : '';
    const remoteBranch = merge.startsWith('refs/heads/') ? merge.slice(11) : branch;
    const ref = `refs/remotes/${name}/${remoteBranch}`;
    const exists = !!await optional(root, ['rev-parse', '--verify', ref]);
    const counts = head && exists ? (await git(root, ['rev-list', '--left-right', '--count', `HEAD...${ref}`])).trim().split(/\s+/).map(Number) : [head ? 1 : 0, 0];
    remote = { name, url: remotes.find(item => item.name === name)!.url, branch: remoteBranch, tracking: !!merge, exists, ahead: counts[0], behind: counts[1] };
  }
  let fetchedAt: string | null = null;
  try { const path = await optional(root, ['rev-parse', '--git-path', 'FETCH_HEAD']); fetchedAt = (await stat(resolve(root, path))).mtime.toISOString(); } catch {}
  return { remotes, remote, fetchedAt };
}
export const remoteRef = (remote: GitRemote) => `refs/remotes/${remote.name}/${remote.branch}`;
export function assertRemoteUrl(remote: GitRemote, url: string): void {
  if (!url || remote.name.startsWith('-') || /\s/.test(remote.name) || url.includes('::') || /^[a-z][a-z0-9+.-]*:\/\//i.test(url) && !/^(https?|ssh|git|file):\/\//i.test(url)) throw new Error('不支持此远程仓库地址，请使用 HTTPS、SSH 或本地仓库。');
}
export async function fetchRemote(root: string, remote: GitRemote, signal: AbortSignal): Promise<void> {
  assertRemoteUrl(remote, (await git(root, ['remote', 'get-url', remote.name])).trim());
  // Fetch a single configured branch; absence means the next push can publish it.
  const refs = await git(root, ['ls-remote', '--heads', remote.name, `refs/heads/${remote.branch}`], signal);
  if (!refs.trim()) { await git(root, ['update-ref', '-d', remoteRef(remote)], signal); return; }
  await git(root, ['fetch', '--no-tags', '--no-recurse-submodules', remote.name, `+refs/heads/${remote.branch}:${remoteRef(remote)}`], signal);
}
