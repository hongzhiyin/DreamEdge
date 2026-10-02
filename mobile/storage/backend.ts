import type { StorageRequest, StoredRecord } from '../../shared/contracts';
import type { StorageClient } from '../../shared/contracts';
import { identifier, validateStorage } from '../../shared/storage-validation';

export interface RecordBackend {
  execute(toolId: string, request: StorageRequest): Promise<StoredRecord[] | void>;
}

export function createToolStore(toolId: string, backend: RecordBackend): StorageClient {
  identifier(toolId);
  async function execute(request: StorageRequest) {
    validateStorage(request);
    return backend.execute(toolId, request);
  }
  return {
    async list(collection) { return (await execute({ operation: 'list', collection })) as StoredRecord[]; },
    async put(collection, id, value) { await execute({ operation: 'put', collection, id, value }); },
    async remove(collection, id) { await execute({ operation: 'remove', collection, id }); },
  };
}
