import { createHash } from 'node:crypto';
import { canonicalJson } from '../tools/json.js';

export const contentHash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export function mutationDigest<T extends object>(preview: T): string {
  const { planDigest: _digest, ...payload } = preview as { planDigest?: string };
  return contentHash(canonicalJson(payload));
}
