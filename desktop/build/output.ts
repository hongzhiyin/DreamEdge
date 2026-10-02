import { randomUUID } from 'node:crypto';
import { rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { ensureDirectory, hash, relativeParts, TEXT_LIMIT, writeText } from '../workspace/paths';
import { BuildFailure, type BuildOutput } from './types';

export async function publishOutput(root: string, output: BuildOutput): Promise<Record<string, string>> {
  const entries = Object.entries(output.files);
  if (!entries.length || entries.length > 300 || !Object.hasOwn(output.files, 'index.html')) throw new BuildFailure([{ level: 'error', message: '构建产物无效。' }]);
  const checksums: Record<string, string> = Object.create(null);
  let bytes = 0;
  for (const [path, content] of entries) {
    relativeParts(path);
    if (typeof content !== 'string' || Buffer.byteLength(content) > TEXT_LIMIT) throw new Error('单个构建产物不能超过 1 MB。');
    bytes += Buffer.byteLength(content); checksums[path] = hash(content);
  }
  if (bytes > 8 * TEXT_LIMIT) throw new Error('构建产物总量不能超过 8 MB。');

  const temporary = `.${randomUUID()}`;
  const staging = await ensureDirectory(root, temporary);
  try {
    for (const [path, content] of entries) await writeText(staging, path, content);
    await rename(staging, join(root, 'output'));
  } finally { await rm(staging, { recursive: true, force: true }); }
  return checksums;
}
