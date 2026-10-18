import { readFile } from 'node:fs/promises';
import { ModelAdapterError } from './errors.js';
import type { CredentialResolver } from './types.js';

export interface CredentialSources {
  credentialsFile?: string;
  environment?: Readonly<Record<string, string | undefined>>;
}

export function createCredentialResolver(sources: CredentialSources = {}): CredentialResolver {
  const environment = sources.environment ?? process.env;
  return async (reference, signal) => {
    signal.throwIfAborted();
    if (/^env:[A-Za-z_][A-Za-z0-9_]*$/.test(reference)) {
      return environment[reference.slice(4)]?.trim() || undefined;
    }
    if (!reference.startsWith('file:') || !reference.slice(5)) {
      throw new ModelAdapterError('CREDENTIAL_ACCESS_FAILED', '凭据引用格式不受支持。');
    }
    if (!sources.credentialsFile) return undefined;
    const data: unknown = JSON.parse(await readFile(sources.credentialsFile, { encoding: 'utf8', signal }));
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new ModelAdapterError('CREDENTIAL_ACCESS_FAILED', '本地凭据文件格式无效。');
    }
    const key = reference.slice(5);
    if (!Object.hasOwn(data, key)) return undefined;
    const value = (data as Record<string, unknown>)[key];
    return typeof value === 'string' ? value.trim() || undefined : undefined;
  };
}
