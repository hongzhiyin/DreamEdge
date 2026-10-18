import { mkdir, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { mutationFixture } from './mutation-loop.js';
import type { Handler } from './server.js';
import { fileOperationTools } from '../../src/files/operation-tools.js';
import type { OperationHost } from '../../src/files/operation-types.js';
export async function operationFixture(t: TestContext, handler: Handler, hooks: Partial<OperationHost> = {}) {
  const f = await mutationFixture(t, handler, {}, 120_000, { account: true });
  const trashDirectory = join(f.directory, 'test-trash'); await mkdir(trashDirectory);
  let trashed = 0;
  for (const tool of fileOperationTools(f.service.fileScopes, { trash: async path => {
    await rename(path, join(trashDirectory, randomUUID())); trashed++;
  }, ...hooks })) f.registry.register(tool);
  return { ...f, trashDirectory, trashed: () => trashed };
}
